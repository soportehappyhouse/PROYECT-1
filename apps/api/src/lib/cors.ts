import type { ApiConfig } from "../config.js";

/** Browser origins allowed to call the api (dashboard + any localhost dev port). */
export function allowedOrigins(config: Pick<ApiConfig, "webOrigin">): (string | RegExp)[] {
  return [config.webOrigin, /^http:\/\/(localhost|127\.0\.0\.1):\d+$/];
}

export function isAllowedOrigin(
  config: Pick<ApiConfig, "webOrigin">,
  origin: string | undefined,
): boolean {
  if (!origin) return false;
  return allowedOrigins(config).some((o) =>
    typeof o === "string" ? o === origin : o.test(origin),
  );
}

/**
 * CORS headers for raw responses (SSE via reply.hijack() / reply.raw bypasses @fastify/cors hooks).
 */
export function rawCorsHeaders(
  config: Pick<ApiConfig, "webOrigin">,
  origin: string | undefined,
): Record<string, string> {
  return isAllowedOrigin(config, origin)
    ? {
        "Access-Control-Allow-Origin": origin!,
        Vary: "Origin",
        "Access-Control-Allow-Credentials": "true",
      }
    : {};
}
