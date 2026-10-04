import {
  API_ROUTES,
  buildRoute,
  type ApiError,
  type AppConfig,
  type HealthResponse,
} from "@studio/shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError | undefined,
  ) {
    super(body?.error.message ?? `HTTP ${status}`);
    this.name = "ApiRequestError";
  }
}

/** Minimal typed fetch wrapper for the local API. */
export async function apiFetch<T>(
  route: string,
  init: RequestInit & { params?: Record<string, string> } = {},
): Promise<T> {
  const { params, ...rest } = init;
  const res = await fetch(`${API_URL}${buildRoute(route, params)}`, {
    ...rest,
    headers: { "content-type": "application/json", ...rest.headers },
  });
  if (!res.ok)
    throw new ApiRequestError(res.status, (await res.json().catch(() => undefined)) as ApiError);
  return (await res.json()) as T;
}

export const api = {
  health: () => apiFetch<HealthResponse>(API_ROUTES.health),
  config: () => apiFetch<AppConfig>(API_ROUTES.config),
  // TODO(module-a): projects, media upload (multipart, no JSON header), jobs SSE (EventSource), etc.
};
