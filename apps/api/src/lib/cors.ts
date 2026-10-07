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
 * Exact browser origins of the Studio web (audit fix 5, HUMAN_ONLY): `config.webOrigin` and the
 * same web port on localhost / 127.0.0.1 / [::1]. Unlike the CORS list, no other port is accepted.
 */
export function webOrigins(config: Pick<ApiConfig, "webOrigin">): string[] {
  const out = [config.webOrigin];
  try {
    const u = new URL(config.webOrigin);
    const port = u.port ? `:${u.port}` : "";
    for (const host of ["localhost", "127.0.0.1", "[::1]"])
      out.push(`${u.protocol}//${host}${port}`);
  } catch {
    // malformed webOrigin: only the literal value
  }
  return [...new Set(out)];
}

export function isWebOrigin(
  config: Pick<ApiConfig, "webOrigin">,
  origin: string | undefined,
): boolean {
  return !!origin && webOrigins(config).includes(origin);
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Host allowlist of the api (audit fix 5, DNS rebinding): `Host` must name the loopback
 * (127.0.0.1 / localhost / [::1], or the configured API_HOST when it is a concrete address) with the
 * api port (`config.port`, or the port the socket really listens on). `localPort` undefined (no real
 * socket: app.inject in tests) skips the port check.
 */
export function isAllowedHost(
  config: Pick<ApiConfig, "host" | "port">,
  host: string | undefined,
  localPort?: number,
): boolean {
  if (!host) return false;
  let u: URL;
  try {
    u = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (u.username || u.password || u.pathname !== "/" || u.search || u.hash) return false;
  const name = u.hostname.toLowerCase();
  const configured = config.host && !["0.0.0.0", "::", "[::]"].includes(config.host);
  if (!LOOPBACK_HOSTS.has(name) && !(configured && name === config.host.toLowerCase()))
    return false;
  if (localPort === undefined) return true;
  const port = Number(u.port || 80);
  return port === config.port || port === localPort;
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
