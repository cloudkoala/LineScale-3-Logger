// Preload: exposes a tiny, safe native API to the renderer. The web app feature-detects
// `window.dynoNative?.isElectron` and otherwise behaves exactly like the browser build.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('dynoNative', {
  isElectron: true,
  // Web Bluetooth device picker bridge (Electron handles device selection in main).
  onBleDevices: (cb) => ipcRenderer.on('ble-devices', (_e, devices) => cb(devices)),
  selectBle: (deviceId) => ipcRenderer.send('ble-select', deviceId),
  cancelBle: () => ipcRenderer.send('ble-cancel'),
  // Join a Wi-Fi network (the GoPro AP). Returns { ok, message }.
  joinWifi: (creds) => ipcRenderer.invoke('join-wifi', creds),
});
