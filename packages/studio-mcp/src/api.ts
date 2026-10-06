/** Minimal client of the local Studio API (http://127.0.0.1:3001 by default). */

export const DEFAULT_API_URL = "http://127.0.0.1:3001";

export class StudioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface StudioApi {
  readonly baseUrl: string;
  get<T = unknown>(path: string, query?: Record<string, string | number | undefined>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
}

function errorFrom(status: number, body: unknown): StudioApiError {
  const b = body as {
    error?: { code?: string; message?: string; details?: unknown } | string;
    message?: string;
  };
  if (b && typeof b.error === "object" && b.error)
    return new StudioApiError(
      status,
      b.error.code ?? `HTTP_${status}`,
      b.error.message ?? `HTTP ${status}`,
      b.error.details,
    );
  // PACK_REQUIRED uses a flat body ({error: "PACK_REQUIRED", packId, message}).
  if (b && typeof b.error === "string")
    return new StudioApiError(status, b.error, b.message ?? b.error, body);
  return new StudioApiError(status, `HTTP_${status}`, `La API respondió ${status}`);
}

export function createStudioApi(
  baseUrl: string = process.env.STUDIO_API_URL ?? DEFAULT_API_URL,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): StudioApi {
  const root = baseUrl.replace(/\/$/, "");
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch {
      throw new StudioApiError(
        0,
        "API_UNREACHABLE",
        `No se pudo conectar con la API de Studio en ${root}. ¿Está abierto Studio? ` +
          "(scripts\\windows\\start.cmd o `pnpm dev`)",
      );
    }
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (!res.ok) throw errorFrom(res.status, json);
    return json as T;
  };
  return {
    baseUrl: root,
    get: (path, query) => {
      const qs = query
        ? Object.entries(query)
            .filter(([, v]) => v !== undefined && v !== "")
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
            .join("&")
        : "";
      return call("GET", qs ? `${path}?${qs}` : path);
    },
    post: (path, body) => call("POST", path, body ?? {}),
  };
}
