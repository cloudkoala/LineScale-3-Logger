// Persisted app preferences (localStorage). Device-side state (scan rate, zero
// mode) is NOT stored here — it lives on the device and is reflected from the
// data stream.

const KEY = 'ls3-settings';

const DEFAULTS = {
  debug: false,               // show the diagnostics panel
  resetGraphOnRecord: true,   // clear the live graph when a recording starts
  autoPauseOnHover: true,     // freeze the live graph while the cursor is over it
  autoSave: false,            // auto-save each recording (CSV + PNG) to a folder
  liveWindowS: 60,            // seconds of history shown on the live graph
};

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

export const settings = { ...DEFAULTS, ...load() };

export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
