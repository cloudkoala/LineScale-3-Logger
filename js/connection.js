// Connection layer. BLEConnection talks to the LS3 over Web Bluetooth.
// All sources (BLE, and later Web Serial / the simulator) share the Source
// interface: connect(), disconnect(), send(cmdName), onReading(cb), onStatus(cb).
// Sources may also emit diagnostics via onDiag(cb) for the debug panel.

import { UUID, CMD, PACKET_LEN, END_FLAG, parsePacket } from './protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Source {
  constructor() {
    this._readingCbs = [];
    this._statusCbs = [];
    this._diagCbs = [];
  }
  onReading(cb) { this._readingCbs.push(cb); return this; }
  onStatus(cb) { this._statusCbs.push(cb); return this; }
  onDiag(cb) { this._diagCbs.push(cb); return this; }
  _emitReading(r) { for (const cb of this._readingCbs) cb(r); }
  _emitStatus(s) { for (const cb of this._statusCbs) cb(s); }
  _diag(d) { for (const cb of this._diagCbs) cb(d); }
  _log(line) { this._diag({ line }); }
}

export class BLEConnection extends Source {
  constructor() {
    super();
    this.device = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this._writeNoResp = false;
    this._buf = [];
    this._watchdog = null;
    this._startTries = 0;
    this.stats = { notifs: 0, bytes: 0, frames: 0, parsed: 0, failed: 0 };
    this._onDisconnect = this._handleDisconnect.bind(this);
    this._onData = this._handleData.bind(this);
  }

  static get supported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  async connect() {
    if (!BLEConnection.supported) {
      throw new Error('Web Bluetooth is not available. Use Chrome or Edge.');
    }
    this._emitStatus({ state: 'connecting' });

    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UUID.service] }],
      optionalServices: [UUID.service],
    });
    this._log(`device: ${this.device.name || '(unnamed)'} [${this.device.id}]`);
    this.device.addEventListener('gattserverdisconnected', this._onDisconnect);

    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(UUID.service);

    // Enumerate the service's characteristics so we can confirm the expected
    // UUIDs and fall back to capability-based detection if they differ.
    const chars = await service.getCharacteristics();
    this._log(`service ${short(UUID.service)} has ${chars.length} characteristic(s):`);
    for (const c of chars) {
      const p = c.properties;
      const flags = [
        p.notify && 'notify', p.indicate && 'indicate', p.read && 'read',
        p.write && 'write', p.writeWithoutResponse && 'writeNoResp',
      ].filter(Boolean).join(',');
      this._log(`  • ${short(c.uuid)}  [${flags}]`);
    }

    this.notifyChar =
      chars.find((c) => c.uuid === UUID.notify) ||
      chars.find((c) => c.properties.notify || c.properties.indicate);
    this.writeChar =
      chars.find((c) => c.uuid === UUID.write) ||
      chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);

    if (!this.notifyChar) throw new Error('No notify characteristic found on device');
    if (!this.writeChar) throw new Error('No writable characteristic found on device');
    this._writeNoResp =
      !this.writeChar.properties.write && this.writeChar.properties.writeWithoutResponse;
    this._log(`notify: ${short(this.notifyChar.uuid)} · write: ${short(this.writeChar.uuid)} (${this._writeNoResp ? 'no-response' : 'with-response'})`);

    this._buf = [];
    this.notifyChar.addEventListener('characteristicvaluechanged', this._onData);
    await this.notifyChar.startNotifications();
    this._log('notifications started');

    this._emitStatus({ state: 'connected', name: this.device.name || 'LineScale 3' });

    // Ask the device to go online and stream at 40 Hz (the BLE maximum). If no
    // data arrives, the watchdog re-sends the start command a few times.
    await this._startStreaming();
    this._armWatchdog();
    return this;
  }

  async _startStreaming() {
    this._startTries++;
    this._log(`sending start (A) + 40Hz (F)  [try ${this._startTries}]`);
    await this.send('ONLINE');
    await sleep(120);
    await this.send('SPEED_40HZ');
  }

  _armWatchdog() {
    clearInterval(this._watchdog);
    this._watchdog = setInterval(async () => {
      if (this.stats.frames > 0) { clearInterval(this._watchdog); this._watchdog = null; return; }
      if (this._startTries >= 5) {
        clearInterval(this._watchdog); this._watchdog = null;
        this._log('⚠ still no data after several attempts — see characteristic list above');
        this._diag({ noData: true });
        return;
      }
      this._log('no data yet — retrying start command');
      try { await this._startStreaming(); } catch (e) { this._log('retry failed: ' + e.message); }
    }, 1500);
  }

  async send(cmdName) {
    const frame = CMD[cmdName];
    if (!frame) throw new Error(`Unknown command: ${cmdName}`);
    if (!this.writeChar) throw new Error('Not connected');
    try {
      if (this._writeNoResp) await this.writeChar.writeValueWithoutResponse(frame);
      else await this.writeChar.writeValue(frame);
    } catch (e) {
      // Fall back to the other write method if the chosen one is unsupported.
      try {
        if (this._writeNoResp) await this.writeChar.writeValue(frame);
        else await this.writeChar.writeValueWithoutResponse(frame);
      } catch (e2) {
        this._log(`write ${cmdName} failed: ${e2.message || e.message}`);
        throw e2;
      }
    }
  }

  async disconnect() {
    clearInterval(this._watchdog); this._watchdog = null;
    try {
      if (this.writeChar) await this.send('OFFLINE').catch(() => {});
      if (this.notifyChar) await this.notifyChar.stopNotifications().catch(() => {});
    } finally {
      if (this.server && this.server.connected) this.server.disconnect();
    }
  }

  _handleDisconnect() {
    clearInterval(this._watchdog); this._watchdog = null;
    this.server = null;
    this.writeChar = null;
    this.notifyChar = null;
    this._emitStatus({ state: 'disconnected' });
  }

  _handleData(event) {
    const view = event.target.value; // DataView
    const bytes = [];
    for (let i = 0; i < view.byteLength; i++) bytes.push(view.getUint8(i));
    this.stats.notifs++;
    this.stats.bytes += bytes.length;
    this._buf.push(...bytes);
    this._diag({ raw: { hex: toHex(bytes), ascii: toAscii(bytes) } });
    this._drainFrames();
  }

  // Split the rolling byte buffer into 20-byte frames terminated by 0x0D,
  // tolerating BLE chunking and the occasional misaligned byte.
  _drainFrames() {
    let end;
    while ((end = this._buf.indexOf(END_FLAG)) !== -1) {
      const frameLen = end + 1;
      let frame = null;
      if (frameLen === PACKET_LEN) {
        frame = this._buf.slice(0, PACKET_LEN);
      } else if (frameLen > PACKET_LEN) {
        // Leading garbage: keep the last 20 bytes up to and including the flag.
        frame = this._buf.slice(frameLen - PACKET_LEN, frameLen);
      }
      this._buf = this._buf.slice(frameLen); // drop consumed bytes either way
      if (frame) {
        this.stats.frames++;
        const reading = parsePacket(Uint8Array.from(frame));
        if (reading) { this.stats.parsed++; this._emitReading(reading); }
        else { this.stats.failed++; this._diag({ parseFail: toAscii(frame) }); }
      }
    }
    this._diag({ stats: { ...this.stats } });
    // Guard against unbounded growth if no end flag ever arrives.
    if (this._buf.length > 4 * PACKET_LEN) {
      this._buf = this._buf.slice(this._buf.length - PACKET_LEN);
    }
  }
}

function short(uuid) {
  // 0000XXXX-0000-1000-8000-00805f9b34fb -> 0xXXXX, else the full uuid.
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  return m ? `0x${m[1]}` : uuid;
}
function toHex(bytes) {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}
function toAscii(bytes) {
  return bytes.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '·')).join('');
}
