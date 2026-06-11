// Recording storage. Live readings are appended to an in-memory recording
// while one is active; on stop it's persisted to IndexedDB so sessions survive
// page reloads. Each recording keeps its full sample series for graphing/export.

const DB_NAME = 'ls3-logger';
const DB_VERSION = 1;
const STORE = 'recordings';

function idb(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class Store {
  constructor() {
    this.db = null;
    this.current = null; // active recording, or null
    this._startWall = 0;
  }

  async open() {
    this.db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this;
  }

  _tx(mode) {
    return this.db.transaction(STORE, mode).objectStore(STORE);
  }

  get recording() { return this.current !== null; }

  startRecording(meta, unit) {
    const m = meta || {};
    this._startWall = Date.now();
    this.current = {
      id: `rec-${this._startWall}`,
      testId: (m.testId || '').trim(),
      sample: (m.sample || '').trim(),
      config: (m.config || '').trim(),
      material: Array.isArray(m.material) ? m.material : (m.material ? [m.material] : []),
      name: m.name && m.name.trim() ? m.name.trim() : `Session ${new Date(this._startWall).toLocaleString()}`,
      startedAt: this._startWall,
      endedAt: null,
      unit,
      max: 0,
      min: 0,
      samples: [], // { t: ms since start, value, abs }
    };
    return this.current;
  }

  // Append a live reading to the active recording. No-op if not recording.
  append(reading, absValue) {
    if (!this.current) return;
    const t = Date.now() - this._startWall;
    this.current.samples.push({ t, value: reading.value, abs: absValue });
    if (reading.value > this.current.max) this.current.max = reading.value;
    if (reading.value < this.current.min) this.current.min = reading.value;
    // Keep unit in sync if the user switches mid-recording.
    this.current.unit = reading.unit;
  }

  // Finalize the active recording. Persists to IndexedDB unless persist:false
  // (used when a folder is the session library and the file is written there).
  async stop({ persist = true } = {}) {
    if (!this.current) return null;
    const rec = this.current;
    rec.endedAt = Date.now();
    rec.count = rec.samples.length;
    rec.duration = rec.endedAt - rec.startedAt;
    if (persist) await idb(this._tx('readwrite').put(rec));
    this.current = null;
    return rec;
  }

  // Persist a finalized recording (used when naming happens after stopping).
  async persist(rec) {
    await idb(this._tx('readwrite').put(rec));
  }

  async list() {
    const all = await idb(this._tx('readonly').getAll());
    return all
      .map((r) => ({
        id: r.id, name: r.name, startedAt: r.startedAt, endedAt: r.endedAt,
        unit: r.unit, max: r.max, count: r.count ?? r.samples?.length ?? 0,
        duration: r.duration ?? (r.endedAt - r.startedAt),
        config: r.config || '',
        material: Array.isArray(r.material) ? r.material : (r.material ? [r.material] : []),
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  async get(id) {
    return idb(this._tx('readonly').get(id));
  }

  async rename(id, name) {
    const rec = await this.get(id);
    if (!rec) return;
    rec.name = name;
    await idb(this._tx('readwrite').put(rec));
  }

  async remove(id) {
    await idb(this._tx('readwrite').delete(id));
  }

  async toCSV(id) {
    const rec = await this.get(id);
    return rec ? recordingToCSV(rec) : '';
  }
}

// Pure CSV serialization (no I/O) — exported for testing and reuse.
export function recordingToCSV(rec) {
  const lines = [
    `# LineScale 3 recording: ${rec.name}`,
    `# test id: ${rec.testId || ''}`,
    `# sample: ${rec.sample || ''}`,
    `# configuration: ${rec.config || ''}`,
    `# material: ${(Array.isArray(rec.material) ? rec.material : (rec.material ? [rec.material] : [])).join('; ')}`,
    `# started: ${new Date(rec.startedAt).toISOString()}`,
    `# unit: ${rec.unit}`,
    `# samples: ${rec.samples.length}  max: ${rec.max}`,
    `time_s,value_${rec.unit},absolute_${rec.unit}`,
  ];
  for (const s of rec.samples) {
    lines.push(`${(s.t / 1000).toFixed(3)},${s.value},${s.abs}`);
  }
  return lines.join('\n');
}
