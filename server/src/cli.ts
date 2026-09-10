/**
 * Management CLI — talks to the gateway's loopback /mgw/* admin surface
 * (protocol §15) so pairing codes land in the RUNNING process state.
 * Usage: node dist/cli.js pair [--qr] | devices | revoke <deviceId>
 * @module cli
 */

import { loadConfig } from "./config.js";

const [command, flag] = process.argv.slice(2);
const deviceIdArg = process.argv[3];
const config = loadConfig();
const base = `http://127.0.0.1:${config.port}`;

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

if (command === "pair") {
  const res = await post("/mgw/pair");
  if (!res.ok) {
    console.error(`gateway not reachable at ${base} (is it running under pm2?)`);
    process.exit(1);
  }
  const { pairingText, expiresAt } = (await res.json()) as { pairingText: string; expiresAt: number };
  console.log("配对载荷（手机扫码/手输，一次性，过期时间见下）:");
  console.log(pairingText);
  console.log("过期:", new Date(expiresAt).toISOString());
  if (flag === "--qr") {
    // minimal terminal QR: print payload; render QR with any offline tool if desired
    console.log("\n(提示: 可用 `qrencode -t ANSIUTF8 '<上面的载荷>'` 在终端渲染二维码)");
  }
} else if (command === "devices") {
  const res = await fetch(`${base}/mgw/devices`);
  if (!res.ok) {
    console.error("gateway not reachable");
    process.exit(1);
  }
  const { devices } = (await res.json()) as { devices: { id: string; name: string; createdAt: number }[] };
  for (const device of devices) {
    console.log(`${device.id}  ${device.name}  created=${new Date(device.createdAt).toISOString()}`);
  }
  if (devices.length === 0) console.log("(no paired devices)");
} else if (command === "revoke" && deviceIdArg !== undefined) {
  const res = await post("/mgw/revoke", { deviceId: deviceIdArg });
  const { revoked } = (await res.json().catch(() => ({ revoked: false }))) as { revoked: boolean };
  console.log(revoked ? `revoked ${deviceIdArg}` : `no active device ${deviceIdArg}`);
} else {
  console.log("usage: cli.js pair [--qr] | devices | revoke <deviceId>");
  process.exit(1);
}
