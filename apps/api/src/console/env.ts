/**
 * Environment of the `claude` child process: the api's own environment minus every secret, so the
 * CLI always uses the user's Claude.ai login (`claude auth login`) and never an API key from `.env`.
 */

/** Names never passed to the console (keys, tokens, secrets, passwords). */
export const SECRET_ENV = /(_API_KEY$|^API_KEY$|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

export function consoleEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || SECRET_ENV.test(k)) continue;
    // Variables that would point Claude Code at another account or billing (API keys, gateways).
    if (/^ANTHROPIC_(AUTH|BASE_URL|API)/i.test(k)) continue;
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  return { ...out, ...extra };
}
