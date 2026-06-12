// Run: node test/video.test.mjs
// Guards that a session's recorded video (.mp4) is cleaned up alongside the CSV/PNG.
// Uses a tiny mock directory handle (the real File System Access API isn't in Node).
import { deleteSession } from '../js/filesave.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

const removed = [];
const dir = { removeEntry: async (n) => { removed.push(n); } };
await deleteSession(dir, 'Beam-03');

check('removes csv', removed.includes('Beam-03.csv'));
check('removes png', removed.includes('Beam-03.png'));
check('removes mp4', removed.includes('Beam-03.mp4'), removed.join(','));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
