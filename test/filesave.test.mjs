// Run: node test/filesave.test.mjs
// Verifies parseSessionCsv reproduces a recording written by recordingToCSV
// (the round-trip that the folder-as-library feature relies on).
import { recordingToCSV } from '../js/store.js';
import { parseSessionCsv } from '../js/filesave.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

const rec = {
  name: 'Pull Test #3',
  startedAt: Date.UTC(2026, 5, 10, 12, 30, 0),
  unit: 'kN',
  max: 5.1,
  samples: [
    { t: 0, value: 1.0, abs: 0.9 },
    { t: 250, value: 5.1, abs: 5.0 },
    { t: 500, value: 0.4, abs: 0.3 },
  ],
};

const csv = recordingToCSV(rec);
const back = parseSessionCsv(csv, 'Pull Test #3');

check('name round-trips', back.name === 'Pull Test #3', back.name);
check('unit round-trips', back.unit === 'kN', back.unit);
check('max round-trips', back.max === 5.1, `${back.max}`);
check('count round-trips', back.count === 3, `${back.count}`);
check('startedAt round-trips', back.startedAt === rec.startedAt, `${back.startedAt} vs ${rec.startedAt}`);
check('duration = last t', back.duration === 500, `${back.duration}`);
check('sample t in ms', back.samples[1].t === 250, `${back.samples[1].t}`);
check('sample value', back.samples[1].value === 5.1, `${back.samples[1].value}`);
check('sample abs', back.samples[1].abs === 5.0, `${back.samples[1].abs}`);

// Missing max header -> recomputed from data.
const noMax = csv.replace(/^#.*max:.*$/m, '# samples: 3');
check('max recomputed when header absent', parseSessionCsv(noMax, 'x').max === 5.1);

// Name falls back to the file's base name when the header is absent.
const noName = csv.replace(/^# LineScale 3 recording:.*$/m, '# x');
check('name falls back to base', parseSessionCsv(noName, 'fallback-base').name === 'fallback-base');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
