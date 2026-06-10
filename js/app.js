// Application wiring: connects a Source (BLE or Simulator) to the Store and UI.

import { BLEConnection } from './connection.js';
import { Simulator } from './simulator.js';
import { Store } from './store.js';
import { UI } from './ui.js';
import { absoluteForce } from './protocol.js';
import { settings, saveSettings } from './settings.js';

const store = new Store();
let connection = null;
let sessionMax = 0;
let lastUnit = null;
let activeSessionId = null;
let recInfoTimer = null;

const ui = new UI({
  onConnectToggle, onSimulate, onCommand, onResetMax, onClearGraph,
  onToggleRecord, onSelectSession, onRenameSession, onExportSession, onExportSessionGraph, onDeleteSession,
  onSetting, onDeviceSetting, onPowerOff,
});

async function main() {
  // Build the UI first so the app renders immediately, independent of storage.
  ui.init();
  ui.initSettings(settings);
  // ?sim=1 auto-starts the simulated device (handy for demos / testing).
  if (new URLSearchParams(location.search).has('sim')) onSimulate();
  // Storage is needed only for saved sessions; load it in the background.
  try {
    await store.open();
    await refreshSessions();
  } catch (err) {
    ui.toast('Saved sessions unavailable: ' + (err.message || err), true);
  }
}

// ---- connection ----------------------------------------------------------

function wire(source) {
  source.onStatus((s) => {
    ui.setStatus(s.state, s.name);
    if (s.state === 'connecting') {
      ui.resetDiag();
    } else if (s.state === 'connected') {
      sessionMax = 0; lastUnit = null;
      ui.clearLive();
      ui.setMax(0);
    } else if (s.state === 'disconnected') {
      connection = null;
      if (store.recording) stopRecording(); // flush any in-progress recording
    }
  });
  source.onReading(handleReading);
  if (source.onDiag) source.onDiag((d) => {
    ui.diag(d);
    if (d.line) console.debug('[LS3]', d.line);
    if (d.raw) console.debug('[LS3] raw', d.raw.hex, '·', d.raw.ascii);
  });
  return source;
}

async function onConnectToggle() {
  if (connection) { await connection.disconnect(); return; }
  try {
    connection = wire(new BLEConnection());
    await connection.connect();
  } catch (err) {
    connection = null;
    ui.setStatus('disconnected');
    ui.toast(err.message || 'Connection failed', true);
  }
}

async function onSimulate() {
  if (connection) await connection.disconnect();
  connection = wire(new Simulator());
  await connection.connect();
  ui.toast('Simulated device running');
}

function handleReading(reading) {
  // Reset max if the unit changed (old max is in the old unit).
  if (lastUnit !== null && reading.unit !== lastUnit) { sessionMax = 0; }
  lastUnit = reading.unit;

  const abs = absoluteForce(reading);
  if (reading.value > sessionMax) sessionMax = reading.value;

  ui.setReading(reading, abs, false);
  ui.setMax(sessionMax, reading.unit);
  ui.pushLive(reading.value);

  if (store.recording) {
    store.append(reading, abs);
  }
}

async function onCommand(cmdName) {
  if (!connection) return;
  try {
    await connection.send(cmdName);
    if (cmdName === 'CLEAR_PEAK') sessionMax = 0; // mirror the device peak clear
  } catch (err) {
    ui.toast(err.message || 'Command failed', true);
  }
}

// Single "reset": clears the app-side max and, if connected, tells the device
// to clear its own peak-hold so the two stay in sync.
function onResetMax() {
  sessionMax = 0;
  ui.setMax(0, lastUnit);
  if (connection) connection.send('CLEAR_PEAK').catch((e) => ui.toast(e.message || 'Reset failed', true));
}

function onClearGraph() { ui.clearLive(); }

// ---- settings -------------------------------------------------------------

// App preferences (persisted).
function onSetting(key, value) {
  settings[key] = value;
  saveSettings();
  if (key === 'debug') ui.toggleDebug(value);
  if (key === 'autoPauseOnHover') ui.setAutoPause(value);
  if (key === 'liveWindowS') ui.setLiveWindow(value);
}

// Device-state settings — sent as BLE commands, only when connected.
async function onDeviceSetting(key, value) {
  if (!connection) return;
  try {
    if (key === 'rate') await connection.send(value === '40' ? 'SPEED_40HZ' : 'SPEED_10HZ');
    else if (key === 'zeroMode') await connection.send(value === 'abs' ? 'ZERO_MODE_ABS' : 'ZERO_MODE_REL');
  } catch (err) {
    ui.toast(err.message || 'Device command failed', true);
  }
}

function onPowerOff() {
  if (!connection) return;
  if (!confirm('Power off the LineScale 3? It will disconnect.')) return;
  connection.send('POWER_OFF').catch(() => {});
}

// ---- recording ------------------------------------------------------------

async function onToggleRecord(name) {
  if (store.recording) {
    await stopRecording();
  } else {
    if (!connection) return;
    if (settings.resetGraphOnRecord) ui.clearLive(); // fresh graph for the new recording
    store.startRecording(name, lastUnit || 'kN');
    ui.setRecordingState(true);
    recInfoTimer = setInterval(updateRecInfo, 250);
    updateRecInfo();
  }
}

function updateRecInfo() {
  const rec = store.current;
  if (!rec) return;
  const dur = ((Date.now() - rec.startedAt) / 1000).toFixed(1);
  ui.setRecInfo(`recording · ${rec.samples.length} pts · ${dur}s`);
}

async function stopRecording() {
  clearInterval(recInfoTimer);
  const rec = await store.stop();
  ui.setRecordingState(false);
  ui.setRecInfo(rec ? `saved “${rec.name}” (${rec.count} pts)` : '');
  await refreshSessions();
}

// ---- sessions -------------------------------------------------------------

async function refreshSessions() {
  const list = await store.list();
  ui.renderSessions(list, activeSessionId);
}

async function onSelectSession(id) {
  activeSessionId = id;
  if (id === null) { await refreshSessions(); return; }
  const rec = await store.get(id);
  if (rec) ui.showSession(rec);
  await refreshSessions();
}

async function onRenameSession(id, name) {
  await store.rename(id, name);
  await refreshSessions();
}

async function onExportSession(id) {
  const csv = await store.toCSV(id);
  const rec = await store.get(id);
  const safe = (rec?.name || 'session').replace(/[^\w\-]+/g, '_');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safe}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Export a saved session's graph as a PNG without loading it into the view.
async function onExportSessionGraph(id) {
  const rec = await store.get(id);
  if (!rec || !rec.samples.length) { ui.toast('No data in this session', true); return; }
  ui.exportGraphPNG({
    name: rec.name,
    xs: rec.samples.map((s) => s.t / 1000),
    ys: rec.samples.map((s) => s.value),
    unit: rec.unit,
  });
}

async function onDeleteSession(id) {
  if (!confirm('Delete this session? This cannot be undone.')) return;
  await store.remove(id);
  if (activeSessionId === id) { activeSessionId = null; ui.showLive(); }
  await refreshSessions();
}

main();
