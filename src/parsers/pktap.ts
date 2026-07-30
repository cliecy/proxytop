import type { PacketEvidence } from "../domain"

export function parsePktapLine(line: string): PacketEvidence | undefined {
  if (!line.trim() || line.startsWith("tcpdump:")) return undefined
  const metadata = line.match(/\(([^)]*)\)/)?.[1]?.split(/,\s*/)
  const interfaceName = metadata?.[0]?.match(/^[\w.-]+$/)?.[0]
  const processMetadata = metadata?.find((field) => field.startsWith("proc "))
  const processMatch = processMetadata?.match(/^proc\s+(.+):(\d+)$/)
  const directionMetadata = metadata?.find((field) => field === "in" || field === "out")
  const lengthMatch = line.match(/(?:length|len)\s+(\d+)/i)

  return {
    timestamp: Date.now(),
    pid: processMatch?.[2] ? Number(processMatch[2]) : undefined,
    process: processMatch?.[1],
    interfaceName,
    direction: directionMetadata,
    bytes: lengthMatch?.[1] ? Number(lengthMatch[1]) : undefined,
    raw: line,
  }
}
