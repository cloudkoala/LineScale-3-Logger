// Application wiring: connects a Source (BLE or Simulator) to the Store and UI.

import { BLEConnection } from './connection.js';
import { Simulator } from './simulator.js';
import { Store, recordingToCSV } from './store.js';
import { UI } from './ui.js';
import { absoluteForce } from './protocol.js';
import { settings, saveSettings } from './settings.js';
import * as fs from './filesave.js';

const store = new Store();
let connection = null;
let sessionMax = 0;
let lastUnit = null;
let activeSessionId = null;
let recInfoTimer = null;
let recordingNamed = false; // did the user type a name for the active recording?
let folderHandle = null; // chosen session-library folder (File System Access API)

// A folder is the session library when auto-save is on and a folder is chosen.
function usingFolder() { return settings.autoSave && !!folderHandle; }
async function folderGranted(prompt = false) { return fs.ensurePermission(folderHandle, { prompt }); }
async function getSessionActive(id) {
  return usingFolder() ? fs.readSession(folderHandle, id) : store.get(id);
}

const ui = new UI({
  onConnectToggle, onSimulate, onCommand, onResetMax, onClearGraph,
  onToggleRecord, onSelectSession, onRenameSession, onExportSession, onExportSessionGraph, onDeleteSession,
  onSetting, onDeviceSetting, onPowerOff, onChooseFolder,
});

async function main() {
  // Build the UI first so the app renders immediately, independent of storage.
  ui.init();
  ui.initSettings(settings);
  ui.setFsSupported(fs.fsSupported());
  // ?sim=1 auto-starts the simulated device — do this before any storage await
  // so the live UI never waits on IndexedDB.
  if (new URLSearchParams(location.search).has('sim')) onSimulate();
  // Restore the previously chosen session-library folder, if any.
  if (fs.fsSupported()) {
    try { folderHandle = (await fs.savedFolder()) || null; } catch { /* ignore */ }
    ui.setFolderName(folderHandle ? folderHandle.name : null);
  }
  // Browser storage is the fallback library; open it regardless for migration.
  try { await store.open(); } catch (err) {
    ui.toast('Saved sessions unavailable: ' + (err.message || err), true);
  }
  await refreshSessions();
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
async function onSetting(key, value) {
  settings[key] = value;
  saveSettings();
  if (key === 'debug') ui.toggleDebug(value);
  if (key === 'autoPauseOnHover') ui.setAutoPause(value);
  if (key === 'liveWindowS') ui.setLiveWindow(value);
  // Switching the session library on/off (folder vs browser storage).
  if (key === 'autoSave') {
    if (value) { if (folderHandle) await activateFolder(); else await onChooseFolder(); }
    await refreshSessions(); // reflect the new source (folder or browser)
  }
}

async function onChooseFolder() {
  if (!fs.fsSupported()) { ui.toast('Folder auto-save needs Chrome or Edge', true); return; }
  try {
    folderHandle = await fs.pickFolder();
    ui.setFolderName(folderHandle.name);
  } catch {
    return; // user dismissed the picker
  }
  if (settings.autoSave) await activateFolder();
  else ui.toast(`Folder set: ${folderHandle.name}`);
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
    recordingNamed = !!(name && name.trim());
    store.startRecording(name, lastUnit || 'kN');
    ui.setRecordingState(true);
    recInfoTimer = setInterval(updateRecInfo, 250);
    updateRecInfo();
    // Pre-authorize the folder now (Start is a user gesture) so the save on
    // Stop is silent even after a page reload.
    if (settings.autoSave && folderHandle) fs.ensurePermission(folderHandle, { prompt: true });
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
  // Stop accumulating immediately so readings don't keep appending while the
  // name dialog is open (finalize without persisting yet).
  const rec = await store.stop({ persist: false });
  ui.setRecordingState(false);
  if (!rec) { await refreshSessions(); return; }

  // Prompt for a name if the user didn't type one (Skip keeps the auto name).
  if (!recordingNamed) {
    const entered = await ui.promptName(rec.name);
    if (entered) rec.name = entered;
  }

  // Save to the active library: the folder, or browser storage.
  if (usingFolder()) { if (rec.samples.length) await saveSessionToFolder(rec); }
  else await store.persist(rec);

  ui.setRecInfo(`saved “${rec.name}” (${rec.count} pts)`);
  await refreshSessions();
}

// Write a finished recording's CSV + PNG to the chosen folder. Falls back to a
// normal download if permission is declined or the write fails.
async function saveSessionToFolder(rec) {
  if (!fs.fsSupported()) return;
  const csvBlob = new Blob([recordingToCSV(rec)], { type: 'text/csv' });
  let pngBlob = null;
  try { pngBlob = await graphBlobFor(rec); } catch { /* keep CSV even if the graph fails */ }

  const files = pngBlob ? { csv: csvBlob, png: pngBlob } : { csv: csvBlob };
  const ok = folderHandle && (await fs.ensurePermission(folderHandle, { prompt: true }));
  if (ok) {
    try {
      const base = await fs.saveFiles(folderHandle, rec.name, files);
      ui.toast(`Saved ${base}.csv${pngBlob ? ' + .png' : ''} to ${folderHandle.name}`);
      return;
    } catch (e) {
      ui.toast('Folder save failed (' + (e.message || e) + ') — downloaded instead', true);
    }
  } else {
    ui.toast('Folder not authorized — downloaded instead', true);
  }
  // Fallback: regular downloads so the data is never lost.
  for (const [ext, blob] of Object.entries(files)) ui._download(blob, `${ui._safeName(rec.name)}.${ext}`);
}

// ---- sessions -------------------------------------------------------------

async function refreshSessions() {
  if (usingFolder()) {
    if (!(await folderGranted(false))) { ui.showReconnect(folderHandle.name, reconnectFolder); return; }
    ui.renderSessions(await fs.listSessions(folderHandle), activeSessionId);
    return;
  }
  ui.renderSessions(await store.list(), activeSessionId);
}

async function reconnectFolder() {
  if (await folderGranted(true)) await refreshSessions();
}

async function onSelectSession(id) {
  activeSessionId = id;
  if (id === null) { await refreshSessions(); return; }
  const rec = await getSessionActive(id);
  if (rec) ui.showSession(rec);
  await refreshSessions();
}

async function onRenameSession(id, name) {
  if (usingFolder()) {
    const newId = await fs.renameSession(folderHandle, id, name);
    if (activeSessionId === id) activeSessionId = newId;
  } else {
    await store.rename(id, name);
  }
  await refreshSessions();
}

async function onExportSession(id) {
  const rec = await getSessionActive(id);
  if (!rec) return;
  const blob = new Blob([recordingToCSV(rec)], { type: 'text/csv' });
  ui._download(blob, `${ui._safeName(rec.name)}.csv`);
}

// Export a saved session's graph as a PNG without loading it into the view.
async function onExportSessionGraph(id) {
  const rec = await getSessionActive(id);
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
  if (usingFolder()) await fs.deleteSession(folderHandle, id);
  else await store.remove(id);
  if (activeSessionId === id) { activeSessionId = null; ui.showLive(); }
  await refreshSessions();
}

// Make the chosen folder the active library: copy any browser-cached sessions
// into it (skipping ones already present), then list from the folder.
async function activateFolder() {
  if (!folderHandle) return;
  if (!(await folderGranted(true))) { ui.toast('Folder not authorized', true); return; }
  let migrated = 0;
  try {
    for (const s of await store.list()) {
      if (await fs.hasSession(folderHandle, s.name)) continue;
      const rec = await store.get(s.id);
      if (!rec || !rec.samples.length) continue;
      const csvBlob = new Blob([recordingToCSV(rec)], { type: 'text/csv' });
      let pngBlob = null;
      try { pngBlob = await graphBlobFor(rec); } catch { /* csv only */ }
      await fs.saveFiles(folderHandle, rec.name, pngBlob ? { csv: csvBlob, png: pngBlob } : { csv: csvBlob });
      migrated++;
    }
  } catch (e) { ui.toast('Migration error: ' + (e.message || e), true); }
  if (migrated) ui.toast(`Copied ${migrated} session${migrated > 1 ? 's' : ''} into ${folderHandle.name}`);
  await refreshSessions();
}

function graphBlobFor(rec) {
  return ui.graphBlob({
    name: rec.name,
    xs: rec.samples.map((s) => s.t / 1000),
    ys: rec.samples.map((s) => s.value),
    unit: rec.unit,
  });
}

main();
