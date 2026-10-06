#!/usr/bin/env node
// Smoke test del protocolo MCP por stdio: lanza dist/index.js, hace initialize + tools/list
// (JSON-RPC delimitado por líneas, como Claude Code) y muestra las herramientas.
// Uso: pnpm --filter @studio/studio-mcp smoke   (opcional: STUDIO_API_URL=http://127.0.0.1:3001
// y SMOKE_CALL=studio_get_project [SMOKE_ARGS={...}] para llamar una herramienta contra la API real).
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const entry = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");
const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiting = new Map();
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  }
});
let nextId = 1;
const request = (method, params) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 15_000);
    waiting.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "studio-smoke", version: "0.1.0" },
  });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const { tools } = await request("tools/list", {});
  console.log(
    `${init.serverInfo.name} ${init.serverInfo.version} (protocolo ${init.protocolVersion})`,
  );
  for (const t of tools) console.log(`  - ${t.name}: ${t.description.slice(0, 70)}…`);
  console.log(`${tools.length} herramientas`);
  if (process.env.SMOKE_CALL) {
    const args = process.env.SMOKE_ARGS ? JSON.parse(process.env.SMOKE_ARGS) : {};
    const res = await request("tools/call", { name: process.env.SMOKE_CALL, arguments: args });
    console.log(`${process.env.SMOKE_CALL} →`, res.content?.[0]?.text?.slice(0, 600));
  }
  child.kill();
  process.exit(tools.length >= 16 ? 0 : 1);
} catch (err) {
  console.error(String(err));
  child.kill();
  process.exit(1);
}
