/**
 * Management CLI (loopback-only, per protocol §15): issue pairing codes,
 * list/revoke devices. Run: node dist/cli.js pair|devices|revoke <id>
 * @module cli
 */

import { loadConfig } from "./config.js";
import { DeviceStore } from "./auth/device-store.js";
import { encodePairingPayload } from "./auth/pairing.js";

const [command, arg] = process.argv.slice(2);
const config = loadConfig();
const store = new DeviceStore({
  dataDir: config.dataDir,
  pairingTtlMs: config.pairingTtlMs,
  maxFailures: config.authMaxFailures,
  failureWindowMs: config.authWindowMs,
});

function publicUrl(): string {
  return process.env.MGW_PUBLIC_URL ?? `wss://dsh.pipicore.cn${config.wsPath}`;
}

if (command === "pair") {
  const { code, expiresAt } = store.issuePairingCode();
  const payload = encodePairingPayload({
    version: 2,
    publicUrl: publicUrl(),
    pairingCode: code,
    expiresAt,
  });
  console.log("配对码:", code);
  console.log("过期时间:", new Date(expiresAt).toISOString());
  console.log("配对载荷（手机扫码/手输）:");
  console.log(payload);
} else if (command === "devices") {
  for (const device of store.listDevices()) {
    console.log(`${device.id}  ${device.name}  created=${new Date(device.createdAt).toISOString()}`);
  }
  if (store.listDevices().length === 0) console.log("(no paired devices)");
} else if (command === "revoke" && arg !== undefined) {
  console.log(store.revoke(arg) ? `revoked ${arg}` : `no active device ${arg}`);
} else {
  console.log("usage: cli.js pair | devices | revoke <deviceId>");
  process.exit(1);
}
