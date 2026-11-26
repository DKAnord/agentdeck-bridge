#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join, resolve } from "node:path";

async function loadMod(name) {
  const distUrl = new URL(`../dist/${name}.js`, import.meta.url);
  const srcUrl = new URL(`../src/${name}.ts`, import.meta.url);
  return import(existsSync(distUrl) ? distUrl.href : srcUrl.href);
}

function readFlagValue(args, flag) {
  const eqPrefix = `${flag}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === flag) {
      const next = args[i + 1];
      return next && !next.startsWith("-") ? next : undefined;
    }
    if (arg.startsWith(eqPrefix)) {
      return arg.slice(eqPrefix.length) || undefined;
    }
  }
  return undefined;
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
  const relayUrl =
    readFlagValue(args, "--relay")?.trim() ||
    process.env.AGENTDECK_RELAY_URL?.trim() ||
    undefined;
  const relaySessionPath =
    readFlagValue(args, "--relay-session")?.trim() ||
    readFlagValue(args, "--session")?.trim() ||
    process.env.AGENTDECK_RELAY_SESSION?.trim() ||
    undefined;
  const hostnameLabel = process.env.AGENTDECK_HOSTNAME?.trim() || hostname();
  const pairOnly =
    args.includes("--pair-only") ||
    (args.includes("--pair") && !args.includes("--serve"));

  if (pairOnly) {
    const { ensureRelaySession, loadRelaySession } =
      await loadMod("relay-client");
    const session = relayUrl
      ? await ensureRelaySession({
          relayUrl,
          sessionPath: relaySessionPath,
          hostLabel: hostnameLabel,
        })
      : loadRelaySession(relaySessionPath);
    if (!session) {
      console.error(
        "No existing relay session found. Pass --relay <url> or set AGENTDECK_RELAY_URL.",
      );
      process.exit(1);
    }
    if (args.includes("--json")) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            roomId: session.roomId,
            relayUrl: session.relayUrl,
            hostLabel: session.hostLabel,
            pairingUri: session.pairingUri,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`Room ID: ${session.roomId}`);
      console.log(`Relay:   ${session.relayUrl}`);
      console.log(`Pair:    ${session.pairingUri}`);
    }
    process.exit(0);
  }

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
  const allowedDirsRaw =
    readFlagValue(args, "--allowed-dirs") ??
    process.env.AGENTDECK_ALLOWED_DIRS ??
    "";
  const allowedDirs = allowedDirsRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const enableGitHubPulse =
    args.includes("--pulse") ||
    (!args.includes("--no-pulse") &&
      process.env.AGENTDECK_GITHUB_PULSE === "1");

  const handle = createBridgeServer({
    host,
    port,
    authToken,
    webhookUrl,
    hostnameLabel,
    memoryDbPath,
    reserveFloorPct,
    relayUrl,
    relaySessionPath,
    allowedDirs,
    enableGitHubPulse,
  });

  const bound = await handle.start();
  console.log(
    `agentdeck-bridge v0.3.0 listening on ${bound.url} (Protocol v1 · auth=${authToken ? "bearer" : "off"} · db=${memoryDbPath})`,
  );
  console.log(`  GET  ${bound.url}/v1/health`);
  console.log(`  GET  ${bound.url}/v1/snapshot`);
  console.log(`  GET  ${bound.url}/v1/events  (SSE stream)`);
  console.log(`  GET  ${bound.url}/v1/pairing`);
  console.log(`  GET  ${bound.url}/v1/pulses`);
  console.log(`  POST ${bound.url}/v1/hooks/claude`);
  console.log(`  POST ${bound.url}/v1/demo-gate`);
  console.log(`  POST ${bound.url}/v1/triage`);
  console.log(`  POST ${bound.url}/v1/dispatch`);
  console.log(`  POST ${bound.url}/v1/free-pool`);
  console.log(`  GET  ${bound.url}/v1/memory`);

  const relayStatus = handle.getRelayStatus();
  if (relayStatus?.pairingUri) {
    console.log(`Relay room: ${relayStatus.roomId}`);
    console.log(`Relay pairing URI: ${relayStatus.pairingUri}`);
  }

  async function shutdown(signal) {
    console.log(`\nReceived ${signal}, stopping agentdeck-bridge...`);
    await handle.stop();
    process.exit(0);
  }

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
