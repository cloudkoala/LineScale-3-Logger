// Run: node test/wifi.test.mjs
// Verifies the pure Wi-Fi-join helpers (macOS interface parsing, Windows profile
// XML + escaping). The actual networksetup/netsh calls need a real OS + adapter.
import wifi from '../electron/wifi.js';
const { parseWifiInterfaceMac, windowsWifiProfileXml, xmlEscape } = wifi;

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

const macOut = `Hardware Port: Ethernet
Device: en1
Ethernet Address: a1:b2:c3:d4:e5:f6

Hardware Port: Wi-Fi
Device: en0
Ethernet Address: 11:22:33:44:55:66

Hardware Port: Bluetooth PAN
Device: en5
Ethernet Address: 00:00:00:00:00:00`;

check('finds the Wi-Fi device name', parseWifiInterfaceMac(macOut) === 'en0', parseWifiInterfaceMac(macOut));
check('handles legacy "AirPort" label', parseWifiInterfaceMac('Hardware Port: AirPort\nDevice: en2\n') === 'en2');
check('returns null when no Wi-Fi port', parseWifiInterfaceMac('Hardware Port: Ethernet\nDevice: en1\n') === null);
check('null/garbage input -> null', parseWifiInterfaceMac('') === null && parseWifiInterfaceMac(undefined) === null);

const xml = windowsWifiProfileXml('GP24512345', 'secretpass');
check('profile includes the SSID', xml.includes('<name>GP24512345</name>'));
check('profile includes the passphrase', xml.includes('<keyMaterial>secretpass</keyMaterial>'));
check('profile is WPA2PSK/AES', xml.includes('WPA2PSK') && xml.includes('AES'));

check('xmlEscape escapes special chars', xmlEscape(`a&b<c>"d'`) === 'a&amp;b&lt;c&gt;&quot;d&apos;');
const xml2 = windowsWifiProfileXml('My&Net', 'p<a>ss&"');
check('SSID with & is escaped in XML', xml2.includes('<name>My&amp;Net</name>'));
check('password with special chars is escaped', xml2.includes('<keyMaterial>p&lt;a&gt;ss&amp;&quot;</keyMaterial>'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
