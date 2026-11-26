#!/usr/bin/env node
import { existsSync } from "node:fs";

const distEntry = new URL("../dist/server.js", import.meta.url);
const srcEntry = new URL("../src/server.ts", import.meta.url);
const { createBridgeServer } = await import(
  existsSync(distEntry) ? distEntry.href : srcEntry.href
);

const host = process.env.AGENTDECK_HOST?.trim() || "127.0.0.1";
const rawPort = Number.parseInt(process.env.AGENTDECK_PORT ?? "7742", 10);
const port = Number.isNaN(rawPort) ? 7742 : rawPort;
const authToken = process.env.AGENTDECK_TOKEN?.trim() || undefined;
const webhookUrl = process.env.AGENTDECK_WEBHOOK_URL?.trim() || undefined;

const handle = createBridgeServer({
  host,
  port,
  authToken,
  webhookUrl,
});

const bound = await handle.start();
console.log(
  `agentdeck-bridge listening on ${bound.url} (Protocol v1 · auth=${authToken ? "bearer" : "off"})`,
);
console.log(`  GET  ${bound.url}/v1/health`);
console.log(`  GET  ${bound.url}/v1/snapshot`);
console.log(`  GET  ${bound.url}/v1/events  (SSE stream)`);
console.log(`  POST ${bound.url}/v1/hooks/claude`);

async function shutdown(signal) {
  console.log(`\nReceived ${signal}, stopping agentdeck-bridge...`);
  await handle.stop();
  process.exit(0);
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
