// View layer: owns the DOM and the uPlot chart. Emits user intents via the
// `handlers` object; receives data via its update methods. Knows nothing about
// BLE or storage.

const $ = (id) => document.getElementById(id);

export class UI {
  constructor(handlers) {
    this.h = handlers;
    this.viewMode = 'live'; // 'live' | 'session'
    this.lx = [];           // live x (seconds, relative to first sample)
    this.ly = [];           // live y (force)
    this.t0 = null;
    this._redrawQueued = false;
    this.chart = null;
    this.windowS = 60;      // live chart history window (seconds)
    this.unit = 'kN';       // unit currently shown on the chart
    this.paused = false;    // live graph frozen by the Pause button?
    this.autoPause = true;  // freeze live graph while cursor is over it?
    this.hoverPaused = false;// currently frozen because the cursor is over the chart
    this.sessionName = null;// name of the session being viewed, if any
  }

  init() {
    // Top bar
    $('connectBtn').onclick = () => this.h.onConnectToggle();
    $('simulateBtn').onclick = () => this.h.onSimulate();

    // Command buttons (data-cmd attribute -> protocol command name)
    document.querySelectorAll('.cmd').forEach((btn) => {
      btn.onclick = () => this.h.onCommand(btn.dataset.cmd);
    });
    $('resetBtn').onclick = () => this.h.onResetMax();
    $('clearGraphBtn').onclick = () => this.h.onClearGraph();
    $('pauseBtn').onclick = () => this.togglePause();
    $('exportGraphBtn').onclick = () => this.exportCurrentGraph();

    // Recording
    $('recordBtn').onclick = () => this.h.onToggleRecord($('recName').value);
    $('liveBtn').onclick = () => this.showLive();

    $('debugClear').onclick = () => { $('debugLog').textContent = ''; };

    // Settings popover
    $('settingsBtn').onclick = (e) => { e.stopPropagation(); this.toggleSettings(); };
    // Connected-device pill -> disconnect menu
    $('status').onclick = (e) => { e.stopPropagation(); this.toggleDeviceMenu(); };
    $('disconnectBtn').onclick = () => { this.toggleDeviceMenu(false); this.h.onConnectToggle(); };
    // Close any open popover when clicking outside it.
    document.addEventListener('click', (e) => {
      if (!$('settingsPanel').hidden && !e.target.closest('.settings-wrap')) this.toggleSettings(false);
      if (!$('deviceMenu').hidden && !e.target.closest('.device-wrap')) this.toggleDeviceMenu(false);
    });
    // App-pref inputs report changes via onSetting(key, value).
    $('setDebug').onchange = () => this.h.onSetting('debug', $('setDebug').checked);
    $('setResetOnRecord').onchange = () => this.h.onSetting('resetGraphOnRecord', $('setResetOnRecord').checked);
    $('setAutoPause').onchange = () => this.h.onSetting('autoPauseOnHover', $('setAutoPause').checked);
    $('setAutoSave').onchange = () => this.h.onSetting('autoSave', $('setAutoSave').checked);
    $('chooseFolderBtn').onclick = () => this.h.onChooseFolder();
    $('setWindow').onchange = () => this.h.onSetting('liveWindowS', Number($('setWindow').value));
    // Device-state inputs send commands via onDeviceSetting(key, value).
    $('setRate').onchange = () => this.h.onDeviceSetting('rate', $('setRate').value);
    $('setZeroMode').onchange = () => this.h.onDeviceSetting('zeroMode', $('setZeroMode').value);
    $('powerOffBtn').onclick = () => this.h.onPowerOff();

    this._buildChart();
    window.addEventListener('resize', () => this._resizeChart());
  }

  // Reflect persisted preferences into the controls at startup.
  initSettings(s) {
    $('setDebug').checked = !!s.debug;
    $('setResetOnRecord').checked = !!s.resetGraphOnRecord;
    $('setAutoPause').checked = !!s.autoPauseOnHover;
    $('setAutoSave').checked = !!s.autoSave;
    $('setWindow').value = String(s.liveWindowS);
    this.setAutoPause(!!s.autoPauseOnHover);
    this.setLiveWindow(s.liveWindowS);
    this.toggleDebug(!!s.debug);
  }

  toggleSettings(force) {
    const panel = $('settingsPanel');
    panel.hidden = force === undefined ? !panel.hidden : !force;
    $('settingsBtn').classList.toggle('active', !panel.hidden);
  }

  toggleDeviceMenu(force) {
    const m = $('deviceMenu');
    m.hidden = force === undefined ? !m.hidden : !force;
  }

  // Folder auto-save controls are only relevant where the File System Access
  // API exists (Chrome/Edge).
  setFsSupported(supported) { $('autoSaveSettings').hidden = !supported; }
  setFolderName(name) { $('folderName').textContent = name || 'No folder chosen'; }

  setLiveWindow(seconds) {
    this.windowS = seconds;
    // Trim the existing buffer to the new window immediately.
    const cutoff = (this.lx[this.lx.length - 1] ?? 0) - seconds;
    while (this.lx.length > 2 && this.lx[0] < cutoff) { this.lx.shift(); this.ly.shift(); }
    if (this.viewMode === 'live') this._queueRedraw();
  }

  // ---- chart -------------------------------------------------------------

  _chartWidth() {
    return Math.max(320, $('chart').clientWidth || 800);
  }

  _buildChart() {
    const opts = {
      width: this._chartWidth(),
      height: 340,
      scales: { x: { time: false } },
      legend: { show: true },
      // Default cursor already snaps a point onto the series at the hovered x.
      cursor: { drag: { x: true, y: false } },
      series: [
        { label: 'time (s)' },
        { label: 'load', stroke: '#3fb6ff', width: 1.6, points: { show: false } },
      ],
      axes: [
        { stroke: '#8b97a6', grid: { stroke: '#2b3340', width: 1 }, ticks: { stroke: '#2b3340' } },
        { stroke: '#8b97a6', grid: { stroke: '#2b3340', width: 1 }, ticks: { stroke: '#2b3340' } },
      ],
      plugins: [this._tooltipPlugin()],
    };
    this.chart = new uPlot(opts, [[0], [0]], $('chart'));

    // Auto-pause: freeze the live graph while the cursor is over it so the
    // trace doesn't scroll out from under the pointer.
    this.chart.over.addEventListener('mouseenter', () => {
      if (this.autoPause && this.viewMode === 'live') this.hoverPaused = true;
    });
    this.chart.over.addEventListener('mouseleave', () => {
      if (this.hoverPaused) {
        this.hoverPaused = false;
        if (this.viewMode === 'live' && !this.paused) this._queueRedraw();
      }
    });
  }

  setAutoPause(on) {
    this.autoPause = on;
    if (!on && this.hoverPaused) {
      this.hoverPaused = false;
      if (this.viewMode === 'live' && !this.paused) this._queueRedraw();
    }
  }

  // uPlot plugin: a floating label that snaps to the load value at the cursor's
  // x position (the marker rides the line, the label shows force + time).
  _tooltipPlugin() {
    const self = this;
    let tip;
    return {
      hooks: {
        init: (u) => {
          tip = document.createElement('div');
          tip.className = 'u-tooltip';
          tip.style.display = 'none';
          u.over.appendChild(tip);
        },
        setCursor: (u) => {
          const idx = u.cursor.idx;
          if (idx == null) { tip.style.display = 'none'; return; }
          const xVal = u.data[0][idx];
          const yVal = u.data[1][idx];
          if (xVal == null || yVal == null) { tip.style.display = 'none'; return; }
          tip.style.display = 'block';
          tip.textContent = `${yVal.toFixed(2)} ${self.unit} · ${xVal.toFixed(1)} s`;
          tip.style.left = u.valToPos(xVal, 'x') + 'px';
          tip.style.top = u.valToPos(yVal, 'y') + 'px';
        },
      },
    };
  }

  _resizeChart() {
    if (this.chart) this.chart.setSize({ width: this._chartWidth(), height: 340 });
  }

  pushLive(value) {
    const now = performance.now() / 1000;
    if (this.t0 === null) this.t0 = now;
    const t = now - this.t0;
    this.lx.push(t);
    this.ly.push(value);
    // Trim to the rolling window.
    const cutoff = t - this.windowS;
    while (this.lx.length > 2 && this.lx[0] < cutoff) {
      this.lx.shift();
      this.ly.shift();
    }
    if (this.viewMode === 'live' && !this.paused && !this.hoverPaused) this._queueRedraw();
  }

  togglePause(force) {
    this.paused = force === undefined ? !this.paused : force;
    const btn = $('pauseBtn');
    btn.textContent = this.paused ? '▶ Play' : '⏸ Pause';
    btn.classList.toggle('active', this.paused);
    if (!this.paused && !this.hoverPaused && this.viewMode === 'live') this._queueRedraw();
  }

  _queueRedraw() {
    if (this._redrawQueued) return;
    this._redrawQueued = true;
    requestAnimationFrame(() => {
      this._redrawQueued = false;
      if (this.viewMode === 'live' && this.chart) this.chart.setData([this.lx, this.ly]);
    });
  }

  showSession(rec) {
    this.viewMode = 'session';
    this.unit = rec.unit;
    this.sessionName = rec.name;
    const xs = rec.samples.map((s) => s.t / 1000);
    const ys = rec.samples.map((s) => s.value);
    this.chart.setData([xs.length ? xs : [0], ys.length ? ys : [0]]);
    $('chartTitle').textContent = `${rec.name} — ${rec.samples.length} samples, max ${rec.max.toFixed(2)} ${rec.unit}`;
    $('liveBtn').hidden = false;
  }

  showLive() {
    this.viewMode = 'live';
    this.sessionName = null;
    $('chartTitle').textContent = 'Live';
    $('liveBtn').hidden = true;
    this.chart.setData([this.lx.length ? this.lx : [0], this.ly.length ? this.ly : [0]]);
    this.h.onSelectSession(null);
  }

  clearLive() {
    this.lx = []; this.ly = []; this.t0 = null;
    if (this.viewMode === 'live') this.chart.setData([[0], [0]]);
  }

  // Export whatever the chart is currently showing (live or a loaded session).
  exportCurrentGraph() {
    const xs = this.chart?.data?.[0], ys = this.chart?.data?.[1];
    if (!xs || xs.length < 2) { this.toast('Nothing to export yet', true); return; }
    const name = this.viewMode === 'session'
      ? (this.sessionName || 'session')
      : `LineScale ${new Date().toLocaleString()}`;
    this.exportGraphPNG({ name, xs: Array.from(xs), ys: Array.from(ys), unit: this.unit });
  }

  // Render the given series to a standalone PNG and download it. Used by the
  // chart's Export button and per-session graph export (no loading).
  exportGraphPNG(opts) {
    this.graphBlob(opts)
      .then((blob) => { this._download(blob, `${this._safeName(opts.name)}.png`); this.toast('Graph exported'); })
      .catch((e) => this.toast('Export failed: ' + (e.message || e), true));
  }

  // Render the given series to a titled PNG and resolve with a Blob (for the
  // Export button and for auto-saving to a folder).
  graphBlob({ name, xs, ys, unit }) {
    return new Promise((resolve, reject) => {
      if (!xs || !xs.length) { reject(new Error('No data to graph')); return; }
      const W = 1200, H = 600;
      const holder = document.createElement('div');
      holder.style.cssText = `position:fixed;left:-99999px;top:0;width:${W}px;height:${H}px;`;
      document.body.appendChild(holder);

      let u;
      try {
        u = new uPlot({
          width: W, height: H, scales: { x: { time: false } }, legend: { show: false }, cursor: { show: false },
          series: [{}, { stroke: '#3fb6ff', width: 2, fill: 'rgba(63,182,255,0.12)', points: { show: false } }],
          axes: [
            { stroke: '#8b97a6', grid: { stroke: '#2b3340', width: 1 } },
            { stroke: '#8b97a6', grid: { stroke: '#2b3340', width: 1 } },
          ],
        }, [xs, ys], holder);
      } catch (e) {
        holder.remove();
        reject(e);
        return;
      }

      // uPlot finishes drawing on a later frame; composite once it has rendered.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        try {
          const src = holder.querySelector('canvas');
          const dpr = src.width / W;
          let max = -Infinity;
          for (const v of ys) if (v > max) max = v;

          const out = document.createElement('canvas');
          out.width = src.width; out.height = src.height;
          const ctx = out.getContext('2d');
          ctx.fillStyle = '#0e1116'; ctx.fillRect(0, 0, out.width, out.height);
          ctx.drawImage(src, 0, 0);

          // Top-left: title + subtitle on a translucent panel for legibility.
          const titleFont = `600 ${Math.round(18 * dpr)}px -apple-system, sans-serif`;
          const subFont = `${Math.round(13 * dpr)}px -apple-system, sans-serif`;
          const sub = `${xs[xs.length - 1].toFixed(1)} s · load (${unit}) vs time (s)`;
          const pad = 12 * dpr;
          ctx.font = titleFont; const tw = ctx.measureText(name).width;
          ctx.font = subFont; const sw = ctx.measureText(sub).width;
          const boxX = 10 * dpr, boxY = 10 * dpr, boxW = Math.max(tw, sw) + pad * 2, boxH = 50 * dpr;
          ctx.fillStyle = 'rgba(10,13,18,0.82)';
          ctx.beginPath(); ctx.roundRect(boxX, boxY, boxW, boxH, 8 * dpr); ctx.fill();
          ctx.fillStyle = '#e6edf3'; ctx.font = titleFont; ctx.fillText(name, boxX + pad, 30 * dpr);
          ctx.fillStyle = '#8b97a6'; ctx.font = subFont; ctx.fillText(sub, boxX + pad, 49 * dpr);

          // Top-right: large MAX readout.
          const rightX = out.width - 18 * dpr;
          ctx.textAlign = 'right';
          ctx.fillStyle = '#8b97a6'; ctx.font = `${Math.round(14 * dpr)}px -apple-system, sans-serif`;
          ctx.fillText('MAX', rightX, 30 * dpr);
          ctx.fillStyle = '#ffb020'; ctx.font = `700 ${Math.round(36 * dpr)}px -apple-system, sans-serif`;
          ctx.fillText(`${max.toFixed(2)} ${unit}`, rightX, 66 * dpr);
          ctx.textAlign = 'left';

          out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('PNG encode failed'))));
        } catch (e) {
          reject(e);
        } finally {
          u.destroy();
          holder.remove();
        }
      }));
    });
  }

  _download(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  _safeName(name) { return String(name).replace(/[^\w\-]+/g, '_'); }

  // ---- readouts ----------------------------------------------------------

  setStatus(state, name) {
    const connected = state === 'connected';
    const connecting = state === 'connecting';

    // Green device pill (clickable, opens the disconnect menu) shows only when connected.
    const pill = $('status');
    pill.hidden = !connected;
    if (connected) pill.textContent = name || 'LineScale 3';
    if (!connected) this.toggleDeviceMenu(false);

    // The Connect button doubles as the disconnected / connecting indicator,
    // and is hidden once connected (disconnect lives in the device-pill menu).
    const btn = $('connectBtn');
    btn.hidden = connected;
    btn.disabled = connecting;
    btn.textContent = connecting ? 'Connecting…' : 'Disconnected';

    // Simulate is available only while fully disconnected.
    $('simulateSection').hidden = connected || connecting;

    // Enable/disable device controls.
    document.querySelectorAll('.cmd').forEach((b) => (b.disabled = !connected));
    document.querySelectorAll('.device-setting').forEach((el) => (el.disabled = !connected));
    $('recordBtn').disabled = !connected;
    // Reset Max is always available (it clears the app-side max readout).
    if (!connected) {
      $('battery').hidden = true;
      $('rate').textContent = '–';
    }
  }

  setReading(reading, absValue, showAbs) {
    this.unit = reading.unit;
    const shown = showAbs ? absValue : reading.value;
    $('current').textContent = shown.toFixed(2);
    $('unit').textContent = reading.unit;
    $('unitMax').textContent = reading.unit;
    $('overload').hidden = !reading.overloaded;
    $('rate').textContent = reading.speedHz ?? '–';

    $('battery').hidden = false;
    $('batteryPct').textContent = reading.battery;

    // Reflect active unit in the segmented control, and device state in Settings.
    document.querySelectorAll('#unitSeg .seg-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.unit === reading.unit));
    if (reading.speedHz === 10 || reading.speedHz === 40) $('setRate').value = String(reading.speedHz);
    if (reading.measureMode === 'N' || reading.measureMode === 'Z')
      $('setZeroMode').value = reading.measureMode === 'N' ? 'abs' : 'rel';
  }

  setMax(value, unit) {
    $('max').textContent = value.toFixed(2);
    if (unit) $('unitMax').textContent = unit;
  }

  setRecordingState(isRecording) {
    const btn = $('recordBtn');
    btn.classList.toggle('recording', isRecording);
    btn.textContent = isRecording ? '■ Stop Recording' : '● Start Recording';
    $('recName').disabled = isRecording;
  }

  setRecInfo(text) { $('recInfo').textContent = text; }

  // ---- session list ------------------------------------------------------

  renderSessions(list, activeId) {
    const ul = $('sessionList');
    ul.innerHTML = '';
    $('noSessions').hidden = list.length > 0;
    for (const s of list) {
      const li = document.createElement('li');
      li.className = 'session-item' + (s.id === activeId ? ' active' : '');

      const name = document.createElement('input');
      name.className = 'session-name';
      name.value = s.name;
      name.onclick = (e) => e.stopPropagation();
      name.onchange = () => this.h.onRenameSession(s.id, name.value);

      const meta = document.createElement('span');
      meta.className = 'session-meta';
      const dur = (s.duration / 1000).toFixed(1);
      meta.textContent = `${new Date(s.startedAt).toLocaleString()} · ${dur}s · max ${s.max.toFixed(2)} ${s.unit} · ${s.count} pts`;

      const actions = document.createElement('div');
      actions.className = 'session-actions';
      actions.append(
        this._iconBtn('View', () => this.h.onSelectSession(s.id)),
        this._iconBtn('Graph', () => this.h.onExportSessionGraph(s.id)),
        this._iconBtn('CSV', () => this.h.onExportSession(s.id)),
        this._iconBtn('Delete', () => this.h.onDeleteSession(s.id), true),
      );

      li.append(name, meta, actions);
      ul.append(li);
    }
  }

  // Show a "reconnect folder" prompt in the sessions area (needed after a
  // reload, when the browser must re-grant folder permission via a gesture).
  showReconnect(folderName, onReconnect) {
    $('noSessions').hidden = true;
    const ul = $('sessionList');
    ul.innerHTML = '';
    const li = document.createElement('li');
    li.className = 'session-item';
    const meta = document.createElement('span');
    meta.className = 'session-meta';
    meta.textContent = `Folder “${folderName}” needs permission to list its sessions.`;
    const btn = document.createElement('button');
    btn.className = 'icon-btn';
    btn.textContent = 'Reconnect folder';
    btn.onclick = onReconnect;
    li.append(meta, btn);
    ul.append(li);
  }

  // Modal name prompt. Resolves to a trimmed name, or null if skipped/empty.
  promptName(defaultName) {
    return new Promise((resolve) => {
      const modal = $('nameModal'), input = $('nameModalInput');
      const save = $('nameModalSave'), cancel = $('nameModalCancel');
      input.value = '';
      input.placeholder = defaultName || 'Session name';
      modal.hidden = false;
      input.focus();
      const done = (val) => {
        modal.hidden = true;
        save.onclick = cancel.onclick = input.onkeydown = null;
        resolve(val && val.trim() ? val.trim() : null);
      };
      save.onclick = () => done(input.value);
      cancel.onclick = () => done(null);
      input.onkeydown = (e) => {
        if (e.key === 'Enter') done(input.value);
        else if (e.key === 'Escape') done(null);
      };
    });
  }

  _iconBtn(label, fn, danger) {
    const b = document.createElement('button');
    b.className = 'icon-btn' + (danger ? ' danger' : '');
    b.textContent = label;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  }

  toast(msg, isErr) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isErr ? ' err' : '');
    t.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => (t.hidden = true), 3200);
  }

  // ---- diagnostics -------------------------------------------------------

  toggleDebug(force) {
    const panel = $('debugPanel');
    panel.hidden = force === undefined ? !panel.hidden : !force;
    $('setDebug').checked = !panel.hidden; // keep the settings toggle in sync
  }

  _logLine(text) {
    const el = $('debugLog');
    el.textContent += text + '\n';
    // Cap the log so it can't grow without bound.
    const lines = el.textContent.split('\n');
    if (lines.length > 300) el.textContent = lines.slice(-300).join('\n');
    el.scrollTop = el.scrollHeight;
  }

  diag(d) {
    if (d.line) this._logLine(d.line);
    if (d.raw) { $('debugRaw').textContent = d.raw.hex; $('debugAscii').textContent = d.raw.ascii; }
    if (d.parseFail) this._logLine('parse-fail: ' + d.parseFail);
    if (d.stats) {
      const s = d.stats;
      $('debugStats').textContent =
        `notifs ${s.notifs} · ${s.bytes}B · frames ${s.frames} · parsed ${s.parsed} · failed ${s.failed}`;
    }
    if (d.noData) {
      this.toggleDebug(true);
      this.toast('Connected, but no data received from the device — see Debug panel', true);
    }
  }

  resetDiag() {
    $('debugStats').textContent = 'waiting…';
    $('debugRaw').textContent = '—';
    $('debugAscii').textContent = '—';
  }
}
