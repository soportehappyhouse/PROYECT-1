/**
 * Environment of the `claude` child process: the api's own environment minus every secret, so the
 * CLI always uses the user's Claude.ai login (`claude auth login`) and never an API key from `.env`.
 */

/** Names never passed to the console (keys, tokens, secrets, passwords, cloud credentials). */
export const SECRET_ENV =
  /(_API_KEY$|^API_KEY$|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|^AWS_ACCESS_KEY_ID$|^AWS_SESSION_TOKEN$|^AWS_SECRET_ACCESS_KEY$|^GOOGLE_APPLICATION_CREDENTIALS$)/i;

/**
 * Kept even though it looks like a secret: the Claude Code CLI's own subscription login
 * (`claude setup-token`), i.e. the user's Claude.ai account, not an API key.
 */
export const KEEP_ENV = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);

export function consoleEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (!KEEP_ENV.has(k.toUpperCase())) {
      if (SECRET_ENV.test(k)) continue;
      // Variables that would point Claude Code at another account or billing (API keys, gateways).
      if (/^ANTHROPIC_(AUTH|BASE_URL|API)/i.test(k)) continue;
    }
    out[k] = v;
  }
  out.TERM = "xterm-256color";
  out.COLORTERM = "truecolor";
  return { ...out, ...extra };
}
