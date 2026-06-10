// Run: node test/store.test.mjs
// Verifies the recording accumulation + CSV logic (the parts independent of
// IndexedDB persistence, which is a thin standard CRUD wrapper).
import { Store, recordingToCSV } from '../js/store.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

const store = new Store();
const rec = store.startRecording('Pull test', 'kN');
check('starts recording', store.recording === true);
check('default-named when blank', store.startRecording('', 'kN').name.startsWith('Session'));

// Re-start clean for the accumulation test.
store.startRecording('Pull test', 'kN');
const samples = [1.0, 3.5, 2.2, 5.1, 0.4];
for (const v of samples) {
  store.append({ value: v, unit: 'kN' }, v - 0.1 /* abs */);
}
check('counts samples', store.current.samples.length === 5);
check('tracks max', store.current.max === 5.1, `got ${store.current.max}`);
check('tracks min', store.current.min === 0, `got ${store.current.min}`); // starts at 0
check('sample shape', store.current.samples[0].value === 1.0 && 'abs' in store.current.samples[0]);

const csv = recordingToCSV(store.current);
const lines = csv.split('\n');
check('CSV header row', lines[4] === 'time_s,value_kN,absolute_kN', lines[4]);
check('CSV has all data rows', lines.length === 5 + samples.length, `got ${lines.length}`);
check('CSV first data row value', lines[5].split(',')[1] === '1', lines[5]);
check('CSV carries absolute col', lines[5].split(',')[2] === '0.9', lines[5]);
check('CSV comment metadata', csv.includes('# unit: kN') && csv.includes('max: 5.1'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
