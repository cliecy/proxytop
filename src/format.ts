import type { PathKind } from "./domain"

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B"
  const units = ["B", "KiB", "MiB", "GiB", "TiB"]
  const exponent = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  const amount = value / 1024 ** exponent
  return `${amount >= 100 || exponent === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[exponent]}`
}

export function formatRate(value: number): string {
  return `${formatBytes(value)}/s`
}

export function fit(value: string, width: number): string {
  if (width <= 0) return ""
  if (value.length > width) return `${value.slice(0, Math.max(0, width - 1))}…`
  return value.padEnd(width)
}

export function pathLabel(path: PathKind): string {
  const labels: Record<PathKind, string> = {
    LOCAL_PROXY: "PROXY",
    TUNNELED: "TUN",
    DIRECT: "DIRECT",
    PROXY_OUTBOUND: "OUTBOUND",
    OVERLAY: "OVERLAY",
    LAN: "LAN",
    BYPASSED: "BYPASS",
    UNKNOWN: "UNKNOWN",
  }
  return labels[path]
}

export function sparkline(values: number[], width: number): string {
  const bars = " ▁▂▃▄▅▆▇█"
  const window = values.slice(-Math.max(1, width))
  if (window.length === 0) return " ".repeat(Math.max(0, width))
  const max = Math.max(...window, 1)
  const graph = window.map((value) => bars[Math.round((value / max) * (bars.length - 1))]).join("")
  return graph.padStart(width)
}
