#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

async function loadMod(name) {
  const distUrl = new URL(`../dist/${name}.js`, import.meta.url);
  const srcUrl = new URL(`../src/${name}.ts`, import.meta.url);
  return import(existsSync(distUrl) ? distUrl.href : srcUrl.href);
}

const args = process.argv.slice(2);
const defaultDbPath = join(homedir(), ".agentdeck", "memory.sqlite");
const memoryDbPath = process.env.AGENTDECK_MEMORY_DB?.trim() || defaultDbPath;

const syncIdx = args.indexOf("--sync-rules");
if (syncIdx !== -1) {
  const { syncAgentInstructionStubs } = await loadMod("memory-store");
  const candidate = args[syncIdx + 1];
  const targetDir = resolve(
    candidate && !candidate.startsWith("-") ? candidate : ".",
  );
  const result = syncAgentInstructionStubs(targetDir);
  console.log(
    `Synced ${result.memoryFile} (${result.updatedFiles.join(", ") || "no changes"})`,
  );
  process.exit(0);
}

if (args.includes("--mcp")) {
  const { createMemoryStore } = await loadMod("memory-store");
  const { startMcpStdioServer } = await loadMod("mcp-stdio");
  const store = createMemoryStore(memoryDbPath);
  const rl = startMcpStdioServer(store);
  const closeMcp = () => {
    rl.close();
    store.close();
    process.exit(0);
  };
  rl.once("close", () => {
    store.close();
    process.exit(0);
  });
  process.once("SIGINT", closeMcp);
  process.once("SIGTERM", closeMcp);
} else {
  const { createBridgeServer } = await loadMod("server");
  const host = process.env.AGENTDECK_HOST?.trim() || "127.0.0.1";
  const rawPort = Number.parseInt(process.env.AGENTDECK_PORT ?? "7742", 10);
  const port = Number.isNaN(rawPort) ? 7742 : rawPort;
  const rawFloor = Number.parseInt(
    process.env.AGENTDECK_RESERVE_FLOOR ?? "20",
    10,
  );
  const reserveFloorPct = Number.isNaN(rawFloor) ? 20 : rawFloor;
  const authToken = process.env.AGENTDECK_TOKEN?.trim() || undefined;
  const webhookUrl = process.env.AGENTDECK_WEBHOOK_URL?.trim() || undefined;

  const handle = createBridgeServer({
    host,
    port,
    authToken,
    webhookUrl,
    memoryDbPath,
    reserveFloorPct,
  });

  const bound = await handle.start();
  console.log(
    `agentdeck-bridge listening on ${bound.url} (Protocol v1 · auth=${authToken ? "bearer" : "off"} · db=${memoryDbPath})`,
  );
  console.log(`  GET  ${bound.url}/v1/health`);
  console.log(`  GET  ${bound.url}/v1/snapshot`);
  console.log(`  GET  ${bound.url}/v1/events  (SSE stream)`);
  console.log(`  POST ${bound.url}/v1/hooks/claude`);
  console.log(`  POST ${bound.url}/v1/dispatch`);
  console.log(`  POST ${bound.url}/v1/free-pool`);
  console.log(`  GET  ${bound.url}/v1/memory`);

  async function shutdown(signal) {
    console.log(`\nReceived ${signal}, stopping agentdeck-bridge...`);
    await handle.stop();
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
