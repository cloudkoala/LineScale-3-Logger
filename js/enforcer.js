// Rock Exotica Enforcer load cell — protocol decoder.
//
// Reverse-engineered (nRF Connect + macOS PacketLogger), 2026-06-12. The device
// speaks an ASCII, CR-terminated protocol on characteristic E7ADD780… (see
// js/profiles.js). To start streaming the app subscribes (indications) then
// writes 'd' (request descriptor) and 'l' (start load stream).
//
// Two CR-terminated frame types arrive:
//   - load reading:  "l 509\r"            -> 'l' + space + raw count
//   - config/info:   d"key"="value";\r    -> e.g. d"i"="17030263"; d"T"=" 400";
//
// Force = (raw − zeroCount) × knPerCount. The official app tares to zero at rest
// (raw sits ~505, ±~5 counts ≈ ±0.02 kN noise). Range 0–20 kN.

// Provisional calibration — TODO: confirm scale with a known high load.
// Anchors so far: raw 505 ≈ 0 kN, raw 575 ≈ 0.32 kN.
let zeroCount = 505;
let knPerCount = 0.32 / 70; // ≈ 0.004571 kN per count

export function setEnforcerCalibration({ zero, scale } = {}) {
  if (Number.isFinite(zero)) zeroCount = zero;
  if (Number.isFinite(scale)) knPerCount = scale;
}

// Last raw count seen — lets the app implement a software tare (the device has
// no zero command; the app subtracts a baseline).
let _lastRaw = null;
export function lastEnforcerRaw() { return _lastRaw; }
export function tareEnforcer() { if (Number.isFinite(_lastRaw)) zeroCount = _lastRaw; }

// Build a reading in the standard shape consumed by app.handleReading and
// store.appendChannel. The Enforcer reads in kN.
export function enforcerReading(value, { battery = null, overloaded = false } = {}) {
  return {
    workingMode: overloaded ? 'O' : 'R',
    overloaded,
    value,
    measureMode: 'N',
    refZero: 0,
    battery,
    unit: 'kN',
    unitCode: 'N',
    speedHz: null,
    checksumOk: true,
  };
}

/**
 * Parse one CR-delimited Enforcer frame (CR already stripped by the framer).
 * Returns a reading for load frames ("l NNN"), or null for config/info frames
 * (d"key"="value";) and anything undecodable. Never throws.
 */
export function parseEnforcerReading(bytes) {
  if (!bytes || !bytes.length) return null;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  s = s.trim();
  if (s.charCodeAt(0) !== 0x6c) return null; // not an 'l ...' load frame
  const raw = parseInt(s.slice(1).trim(), 10);
  if (!Number.isFinite(raw)) return null;
  _lastRaw = raw;
  return enforcerReading((raw - zeroCount) * knPerCount);
}
