#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createStudioMcpServer } from "./server.js";

/**
 * studio-mcp: servidor MCP por stdio que Claude Code lanza desde `.mcp.json` (raíz del repo).
 * Habla con la API local de Studio (STUDIO_API_URL, por defecto http://127.0.0.1:3001).
 * stdout es del protocolo: los mensajes de diagnóstico van a stderr.
 */
const server = createStudioMcpServer();
await server.connect(new StdioServerTransport());
process.stderr.write(
  `studio-mcp listo (API ${process.env.STUDIO_API_URL ?? "http://127.0.0.1:3001"})\n`,
);
