// Run: node test/gopro-usb.test.mjs
// Verifies usbGoProIp() derives the GoPro USB camera IP (host .51 on the GoPro
// USB subnet 172.2X.1YZ.0/24) from this machine's interface addresses.
import { usbGoProIp } from '../gopro-bridge/bridge.js';

let pass = 0, fail = 0;
const check = (name, cond, detail = '') =>
  cond ? (pass++, console.log(`  ok  ${name}`))
       : (fail++, console.error(`FAIL  ${name}  ${detail}`));

check('derives .51 from a GoPro USB address', usbGoProIp(['172.24.156.55']) === '172.24.156.51', usbGoProIp(['172.24.156.55']));
check('works for a different serial subnet', usbGoProIp(['172.29.101.2']) === '172.29.101.51', usbGoProIp(['172.29.101.2']));
check('host already .51 stays .51', usbGoProIp(['172.20.100.51']) === '172.20.100.51');
check('ignores normal LAN/Wi-Fi addresses', usbGoProIp(['192.168.1.40', '10.0.0.5']) === null);
check('ignores the GoPro Wi-Fi AP subnet (10.5.5.x)', usbGoProIp(['10.5.5.100']) === null);
check('ignores 172.16.x (Docker/VPN, not GoPro pattern)', usbGoProIp(['172.16.5.4']) === null);
check('picks the GoPro iface among several', usbGoProIp(['192.168.0.2', '172.27.118.60', 'fe80::1']) === '172.27.118.51');
check('empty / missing input -> null', usbGoProIp([]) === null && usbGoProIp(undefined) === null);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
