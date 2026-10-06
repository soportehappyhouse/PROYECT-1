import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createStudioApi, StudioApiError, type StudioApi } from "./api.js";
import { TOOLS, type ToolDeps } from "./tools.js";

export const SERVER_NAME = "studio-mcp";
export const SERVER_VERSION = "0.1.0";

/** Results longer than this are cut (Claude Code shows a warning above ~25k tokens). */
const MAX_TEXT = 60_000;

export interface ServerOptions {
  api?: StudioApi;
  deps?: Partial<ToolDeps>;
}

function text(value: unknown) {
  let json = JSON.stringify(value);
  if (json === undefined) json = "null";
  if (json.length > MAX_TEXT)
    json = `${json.slice(0, MAX_TEXT)}… [recortado: ${json.length} caracteres]`;
  return json;
}

/** STORAGE_DIR from the api (GET /api/console/status), cached; env STUDIO_STORAGE_DIR wins. */
function storageDirResolver(api: StudioApi): () => Promise<string | undefined> {
  let cached: string | undefined = process.env.STUDIO_STORAGE_DIR || undefined;
  return async () => {
    if (cached) return cached;
    try {
      const st = await api.get<{ storageDir?: string }>("/api/console/status");
      cached = st.storageDir;
    } catch {
      // the api is not running: keep relative paths
    }
    return cached;
  };
}

export function createStudioMcpServer(opts: ServerOptions = {}): McpServer {
  const api = opts.api ?? createStudioApi();
  const deps: ToolDeps = { api, storageDir: storageDirResolver(api), ...opts.deps };
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Herramientas de Studio (editor de video local). Leé CLAUDE.md del repo. Antes de borrar o " +
        "exportar, preguntale al usuario. Preferí studio_validate_plan/studio_propose_plan + " +
        "studio_apply_plan a editar archivos a mano. Nunca toques storage/ ni .env.",
    },
  );
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: {
          title: tool.title,
          readOnlyHint: Boolean(tool.readOnly),
          destructiveHint: Boolean(tool.destructive),
          openWorldHint: false,
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (args: any) => {
        try {
          const result = await (tool.run as (a: unknown, d: ToolDeps) => Promise<unknown>)(
            args,
            deps,
          );
          return { content: [{ type: "text" as const, text: text(result) }] };
        } catch (err) {
          const e =
            err instanceof StudioApiError
              ? {
                  code: err.code,
                  status: err.status,
                  message: err.message,
                  ...(err.details !== undefined && { details: err.details }),
                }
              : { code: "ERROR", message: err instanceof Error ? err.message : String(err) };
          return { isError: true, content: [{ type: "text" as const, text: text({ error: e }) }] };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
  }
  return server;
}
