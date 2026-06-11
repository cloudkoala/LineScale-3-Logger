// Run: node test/store.test.mjs
// Verifies the recording accumulation + CSV logic (the parts independent of
// IndexedDB persistence, which is a thin standard CRUD wrapper).
import { Store, recordingToCSV } from '../js/store.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

const store = new Store();
store.startRecording({ testId: 'Pull', sample: '01', name: 'Pull-01' }, 'kN');
check('starts recording', store.recording === true);
check('names from meta', store.current.name === 'Pull-01', store.current.name);
check('default-named when blank', store.startRecording({}, 'kN').name.startsWith('Session'));

// Re-start clean for the accumulation test, with full metadata.
store.startRecording({ testId: 'Pull', sample: '01', config: 'lap joint', material: 'Al', name: 'Pull-01' }, 'kN');
const samples = [1.0, 3.5, 2.2, 5.1, 0.4];
for (const v of samples) store.append({ value: v, unit: 'kN' }, v - 0.1 /* abs */);

check('counts samples', store.current.samples.length === 5);
check('tracks max', store.current.max === 5.1, `got ${store.current.max}`);
check('tracks min', store.current.min === 0, `got ${store.current.min}`); // starts at 0
check('sample shape', store.current.samples[0].value === 1.0 && 'abs' in store.current.samples[0]);

const csv = recordingToCSV(store.current);
const lines = csv.split('\n');
const headerIdx = lines.findIndex((l) => l.startsWith('time_s'));
const dataRows = lines.slice(headerIdx + 1).filter(Boolean);

check('CSV column header present', lines[headerIdx] === 'time_s,value_kN,absolute_kN', lines[headerIdx]);
check('CSV has all data rows', dataRows.length === samples.length, `got ${dataRows.length}`);
check('CSV first data row value', dataRows[0].split(',')[1] === '1', dataRows[0]);
check('CSV carries absolute col', dataRows[0].split(',')[2] === '0.9', dataRows[0]);
check('CSV unit + max metadata', csv.includes('# unit: kN') && csv.includes('max: 5.1'));
check('CSV new metadata fields', csv.includes('# test id: Pull') && csv.includes('# configuration: lap joint') && csv.includes('# material: Al'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
