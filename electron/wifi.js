// Native Wi-Fi join for the Electron app: connect this computer to the GoPro's
// Wi-Fi access point given an SSID + password (obtained over BLE). macOS uses
// `networksetup`, Windows uses `netsh wlan`. CommonJS (loaded by main.js).
//
// The pure helpers (parseWifiInterfaceMac, windowsWifiProfileXml, xmlEscape) are
// exported for unit testing without spawning anything.

const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const run = promisify(execFile);

// Parse `networksetup -listallhardwareports` and return the Wi-Fi device name
// (e.g. "en0"), or null. The port is labelled "Wi-Fi" on modern macOS and
// "AirPort" on older versions.
function parseWifiInterfaceMac(output) {
  const blocks = String(output || '').split(/\n(?=Hardware Port:)/);
  for (const b of blocks) {
    if (/Hardware Port:\s*(Wi-Fi|AirPort)/i.test(b)) {
      const m = b.match(/Device:\s*(\S+)/);
      if (m) return m[1];
    }
  }
  return null;
}

function xmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));
}

// A WPA2-PSK profile for `netsh wlan add profile`. The GoPro AP is WPA2/AES.
function windowsWifiProfileXml(ssid, password) {
  const s = xmlEscape(ssid);
  return `<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
  <name>${s}</name>
  <SSIDConfig><SSID><name>${s}</name></SSID></SSIDConfig>
  <connectionType>ESS</connectionType>
  <connectionMode>auto</connectionMode>
  <MSM><security>
    <authEncryption><authentication>WPA2PSK</authentication><encryption>AES</encryption><useOneX>false</useOneX></authEncryption>
    <sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>${xmlEscape(password)}</keyMaterial></sharedKey>
  </security></MSM>
</WLANProfile>`;
}

async function joinMac(ssid, password) {
  let iface = null;
  try { iface = parseWifiInterfaceMac((await run('networksetup', ['-listallhardwareports'])).stdout); } catch { /* fall back */ }
  iface = iface || 'en0';
  const args = ['-setairportnetwork', iface, ssid];
  if (password) args.push(password);
  // networksetup reports failures on stdout with exit code 0, so inspect the text.
  const { stdout } = await run('networksetup', args);
  const out = (stdout || '').trim();
  if (/could not|failed|error|not find/i.test(out)) return { ok: false, message: out || `Could not join "${ssid}"` };
  return { ok: true, message: `Joined "${ssid}" on ${iface}` };
}

async function joinWindows(ssid, password) {
  const xml = windowsWifiProfileXml(ssid, password);
  const tmp = path.join(os.tmpdir(), `dyno-wifi-${process.pid}-${Date.now()}.xml`);
  await fs.writeFile(tmp, xml, 'utf8');
  try {
    await run('netsh', ['wlan', 'add', 'profile', `filename=${tmp}`, 'user=current']);
    await run('netsh', ['wlan', 'connect', `name=${ssid}`, `ssid=${ssid}`]);
    return { ok: true, message: `Joining "${ssid}"…` };
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

// Join a Wi-Fi network. Returns { ok, message }; never throws.
async function joinWifi({ ssid, password } = {}) {
  if (!ssid) return { ok: false, message: 'No Wi-Fi network name provided' };
  try {
    if (process.platform === 'darwin') return await joinMac(ssid, password);
    if (process.platform === 'win32') return await joinWindows(ssid, password);
    return { ok: false, message: `Auto-join isn't supported on ${process.platform}. Join "${ssid}" manually (password: ${password || 'n/a'}).` };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

module.exports = { joinWifi, parseWifiInterfaceMac, windowsWifiProfileXml, xmlEscape };
