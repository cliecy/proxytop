export function isLocalDestination(host: string): boolean {
  const normalized = host.toLowerCase()
  if (!normalized || normalized === "*") return false
  if (normalized === "localhost" || normalized.endsWith(".local")) return true
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    /^10\./.test(normalized) ||
    /^192\.168\./.test(normalized) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(normalized) ||
    /^169\.254\./.test(normalized) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(normalized) ||
    /^198\.(18|19)\./.test(normalized) ||
    /^fe80:/.test(normalized) ||
    /^f[cd][0-9a-f]{2}:/.test(normalized) ||
    /^ff0[0-9a-f]:/.test(normalized) ||
    /^::ffff:0:c6(?:12|13):/.test(normalized)
  )
}
