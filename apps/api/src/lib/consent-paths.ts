/**
 * `consent/persons/…` and `consent/archive/…` (POSIX or Windows separators, also JSON-escaped)
 * -> `consent/<oculto>`: Person photos, voice samples and evidence never appear in error reports,
 * job diagnostics or logs (sprint 4; audit fix 22).
 */
export function hideConsentPaths(text: string): string {
  return text.replace(/consent([\\/]+)(persons|archive)\1[^\s"'<>]*/gi, "consent/<oculto>");
}
