// LineScale 3 (LS3) communication protocol.
// Pure functions only — no I/O — so this module is trivially testable.
//
// Source: LineGrip "Communication protocol between LS3 Bluetooth and USB to UART"
// (LS3_command_table_&_port_protocol.pdf), cross-checked against beniseman/lineScale.

export const UUID = {
  service: '00001000-0000-1000-8000-00805f9b34fb',
  notify:  '00001002-0000-1000-8000-00805f9b34fb', // device -> us (20-byte data frames)
  write:   '00001001-0000-1000-8000-00805f9b34fb', // us -> device (commands)
};

export const PACKET_LEN = 20;
export const END_FLAG = 0x0d; // '\r'

// Map a single-letter command to its 4-byte frame: <cmd> 0D 0A <crc>,
// where crc = (cmd + 0x0D + 0x0A) & 0xFF. Verified against the spec
// (e.g. 'A' 0x41 -> crc 0x58, 'O' 0x4F -> crc 0x66).
function frame(letter) {
  const cmd = letter.charCodeAt(0);
  const crc = (cmd + END_FLAG + 0x0a) & 0xff;
  return new Uint8Array([cmd, END_FLAG, 0x0a, crc]);
}

// Commands that are valid over Bluetooth (640/1280 Hz speeds are USB-only).
export const CMD = {
  POWER_OFF:   frame('O'),
  ZERO:        frame('Z'), // zero the current reading
  UNIT_KN:     frame('N'),
  UNIT_KGF:    frame('G'),
  UNIT_LBF:    frame('B'),
  SPEED_10HZ:  frame('S'),
  SPEED_40HZ:  frame('F'),
  ZERO_MODE_TOGGLE: frame('L'),
  ZERO_MODE_REL:    frame('X'), // relative (zero) mode
  ZERO_MODE_ABS:    frame('Y'), // absolute (net) mode
  SET_ABS_ZERO: frame('T'),     // tare: set current value as absolute zero
  CLEAR_PEAK:   frame('C'),     // clear the device's stored peak
  ONLINE:       frame('A'),     // request online -> begins streaming
  OFFLINE:      frame('E'),     // disconnect online session
};

const UNIT = { N: 'kN', G: 'kgf', B: 'lbf' };
const SPEED_HZ = { S: 10, F: 40, M: 640, Q: 1280 };

function ascii(bytes, start, len) {
  let s = '';
  for (let i = start; i < start + len; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// Validate the trailing checksum: decimal sum of bytes 0..16, low two
// decimal digits, encoded as the two ASCII chars at index 17..18.
function checksumOk(bytes) {
  let sum = 0;
  for (let i = 0; i <= 16; i++) sum += bytes[i];
  const expected = sum % 100;
  const got = parseInt(ascii(bytes, 17, 2), 10);
  return got === expected;
}

/**
 * Parse one 20-byte LS3 data frame.
 * @param {Uint8Array} bytes
 * @returns {object|null} reading, or null if the frame is malformed.
 *
 * reading = {
 *   workingMode: 'R'|'O'|'C',  // real-time | overloaded | at max capacity
 *   overloaded: boolean,
 *   value: number,             // value the device is displaying, in `unit`
 *   measureMode: 'N'|'Z',      // absolute | relative zero
 *   refZero: number,
 *   battery: number,           // 0..100 (%)
 *   unit: 'kN'|'kgf'|'lbf',
 *   unitCode: 'N'|'G'|'B',
 *   speedHz: number,
 *   checksumOk: boolean,
 * }
 */
export function parsePacket(bytes) {
  if (!bytes || bytes.length !== PACKET_LEN) return null;
  if (bytes[PACKET_LEN - 1] !== END_FLAG) return null;

  const workingMode = String.fromCharCode(bytes[0]);
  const value = parseFloat(ascii(bytes, 1, 6));
  const measureMode = String.fromCharCode(bytes[7]);
  const refZero = parseFloat(ascii(bytes, 8, 6));
  const battery = Math.max(0, Math.min(100, (bytes[14] - 0x20) * 2));
  const unitCode = String.fromCharCode(bytes[15]);
  const speedCode = String.fromCharCode(bytes[16]);

  if (!Number.isFinite(value)) return null;

  return {
    workingMode,
    overloaded: workingMode === 'O',
    value,
    measureMode,
    refZero: Number.isFinite(refZero) ? refZero : 0,
    battery,
    unit: UNIT[unitCode] || unitCode,
    unitCode,
    speedHz: SPEED_HZ[speedCode] || null,
    checksumOk: checksumOk(bytes),
  };
}

// Absolute force = displayed value plus the reference-zero offset when in
// relative-zero mode (matches the Arduino library's absolute-force figure).
export function absoluteForce(reading) {
  if (!reading) return 0;
  return reading.measureMode === 'Z' ? reading.value + reading.refZero : reading.value;
}

// Build a textual 20-byte frame (without trailing checksum/end handled here)
// — used by the simulator to produce spec-accurate packets.
export function encodePacket({
  workingMode = 'R',
  value = 0,
  measureMode = 'N',
  refZero = 0,
  battery = 100,
  unitCode = 'N',
  speedCode = 'F',
} = {}) {
  const fmt = (n) => {
    // 6-char field: sign-aware, fixed 2 decimals, e.g. "000.63" / "-32.84".
    const neg = n < 0;
    let body = Math.abs(n).toFixed(2);            // e.g. "0.63"
    const width = neg ? 5 : 6;                    // reserve a column for '-'
    body = body.padStart(width, '0');             // "000.63"
    return (neg ? '-' : '') + body;
  };

  const head =
    workingMode +
    fmt(value) +
    measureMode +
    fmt(refZero);
  const batByte = String.fromCharCode(0x20 + Math.round(battery / 2));
  const body = head + batByte + unitCode + speedCode; // bytes 0..16

  const bytes = new Uint8Array(PACKET_LEN);
  for (let i = 0; i < 17; i++) bytes[i] = body.charCodeAt(i);
  let sum = 0;
  for (let i = 0; i <= 16; i++) sum += bytes[i];
  const chk = String(sum % 100).padStart(2, '0');
  bytes[17] = chk.charCodeAt(0);
  bytes[18] = chk.charCodeAt(1);
  bytes[19] = END_FLAG;
  return bytes;
}
