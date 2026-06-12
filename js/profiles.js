// Device profiles. A profile describes everything BLEConnection needs to talk
// to one kind of device, so a single generic backend serves many devices.
//
// Profile shape:
//   {
//     deviceType, deviceLabel, defaultUnit, canSetUnit,
//     services:   [uuid...],     // requestDevice filter + getPrimaryService
//     notifyUuid, writeUuid,     // preferred characteristics (capability fallback still applies)
//     cmd:        { name: Uint8Array },  // named command frames
//     parse:      (Uint8Array) => reading|null,
//     endFlag, packetLen,        // frame splitter; null/undefined => one notification = one frame
//     startStream:(conn, tries) => Promise,  // commands to begin streaming (optional)
//     ignoreUnknownCmd: bool,    // send() silently ignores unmapped commands
//     acceptAllDevices: bool,    // requestDevice scans all devices (unknown service UUID)
//   }

import { UUID, CMD, PACKET_LEN, END_FLAG, parsePacket } from './protocol.js';
import { parseEnforcerReading } from './enforcer.js';

// LineScale 3 — the original device. This makes the existing behaviour the
// "default profile" with no functional change.
export const LS3_PROFILE = {
  deviceType: 'ls3',
  deviceLabel: 'LineScale 3',
  defaultUnit: 'kN',
  canSetUnit: true,
  services: [UUID.service],
  notifyUuid: UUID.notify,
  writeUuid: UUID.write,
  cmd: CMD,
  parse: parsePacket,
  endFlag: END_FLAG,
  packetLen: PACKET_LEN,
  ignoreUnknownCmd: false,
  acceptAllDevices: false,
  async startStream(conn, tries) {
    conn._log(`sending start (A) + 40Hz (F)  [try ${tries}]`);
    await conn.send('ONLINE');
    await new Promise((r) => setTimeout(r, 120));
    await conn.send('SPEED_40HZ');
  },
};

// Rock Exotica Enforcer — SCAFFOLD. Service UUID, commands, and frame format are
// unknown until captured via Discovery mode (see js/enforcer.js). Connecting via
// this profile will pair but won't stream until those TODOs are filled.
export const ENFORCER_PROFILE = {
  deviceType: 'enforcer',
  deviceLabel: 'Rock Exotica Enforcer',
  defaultUnit: 'kN',
  canSetUnit: false,              // Enforcer is kN-only (likely)
  // Discovered via nRF Connect (reverse-engineering). One characteristic does
  // double duty: write commands to it, receive load data back via indications.
  services: ['0bd51666-e7cb-469b-8e4d-2742f1ba77cc'],
  notifyUuid: 'e7add780-b042-4876-aae1-112855353cc1',
  writeUuid: 'e7add780-b042-4876-aae1-112855353cc1',
  // Commands are single raw bytes written to the data characteristic.
  cmd: {
    DESC: Uint8Array.from([0x64]), // 'd' — request the device descriptor dump
    LOAD: Uint8Array.from([0x6c]), // 'l' — start the load (force) stream
  },
  parse: parseEnforcerReading,
  endFlag: 0x0d,                  // CR-terminated frames…
  packetLen: null,                // …of variable length (delimited mode)
  ignoreUnknownCmd: true,         // rate/zero-mode/unit broadcasts become no-ops
  // Keep scanning all devices: the chooser shows the Enforcer even if it doesn't
  // advertise the custom service, and the service is read once connected.
  acceptAllDevices: true,
  // Reverse-engineered startup: subscribe (handled by startNotifications) then
  // write 'd' (descriptor) and 'l' (start streaming load).
  async startStream(conn, tries) {
    conn._log(`enforcer start: d + l  [try ${tries}]`);
    await conn.send('DESC');
    await new Promise((r) => setTimeout(r, 80));
    await conn.send('LOAD');
  },
};
