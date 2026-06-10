// Run: node test/protocol.test.mjs
import { parsePacket, encodePacket, absoluteForce, CMD } from '../js/protocol.js';

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}  ${detail}`); }
}

// 1. Spec example packet: "R000.63Z-32.84RNS10\r"
//    0.63 kN, relative-zero, 10 Hz, 100% battery, reference zero -32.84.
const example = Uint8Array.from([
  0x52, 0x30, 0x30, 0x30, 0x2e, 0x36, 0x33, 0x5a, 0x2d, 0x33,
  0x32, 0x2e, 0x38, 0x34, 0x52, 0x4e, 0x53, 0x31, 0x30, 0x0d,
]);
const r = parsePacket(example);
check('parses spec example', r !== null);
check('value = 0.63', Math.abs(r.value - 0.63) < 1e-9, `got ${r.value}`);
check('measureMode = Z', r.measureMode === 'Z', r.measureMode);
check('refZero = -32.84', Math.abs(r.refZero - -32.84) < 1e-9, `got ${r.refZero}`);
check('unit = kN', r.unit === 'kN', r.unit);
check('speed = 10 Hz', r.speedHz === 10, `got ${r.speedHz}`);
check('battery = 100%', r.battery === 100, `got ${r.battery}`);
check('checksum valid', r.checksumOk === true);
check('absoluteForce = value + refZero', Math.abs(absoluteForce(r) - (0.63 - 32.84)) < 1e-9);

// 2. Reject malformed frames.
check('rejects wrong length', parsePacket(Uint8Array.from([0x52, 0x0d])) === null);
const noEnd = Uint8Array.from(example); noEnd[19] = 0x00;
check('rejects missing end flag', parsePacket(noEnd) === null);

// 3. Command frames have correct CRC (sum of first 3 bytes, low byte).
for (const [name, frame] of Object.entries(CMD)) {
  const crc = (frame[0] + frame[1] + frame[2]) & 0xff;
  check(`CMD.${name} crc`, frame[3] === crc, `got ${frame[3].toString(16)}`);
}
check('CMD.ONLINE bytes', [...CMD.ONLINE].join() === [0x41, 0x0d, 0x0a, 0x58].join());

// 4. encodePacket -> parsePacket round-trip in each unit.
for (const [unitCode, unit] of [['N', 'kN'], ['G', 'kgf'], ['B', 'lbf']]) {
  const enc = encodePacket({ value: 12.34, unitCode, speedCode: 'F', battery: 50 });
  const dec = parsePacket(enc);
  check(`round-trip ${unit} value`, dec && Math.abs(dec.value - 12.34) < 1e-9, `got ${dec && dec.value}`);
  check(`round-trip ${unit} unit`, dec && dec.unit === unit, dec && dec.unit);
  check(`round-trip ${unit} checksum`, dec && dec.checksumOk, 'checksum');
  check(`round-trip ${unit} battery`, dec && dec.battery === 50, dec && dec.battery);
}

// 5. Negative value encoding round-trip.
const negDec = parsePacket(encodePacket({ value: -5.5, unitCode: 'N' }));
check('round-trip negative', negDec && Math.abs(negDec.value - -5.5) < 1e-9, `got ${negDec && negDec.value}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
