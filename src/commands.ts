export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  onLimit: () => void,
): Promise<{ text: string; truncated: boolean }> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let bytes = 0
  let text = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.byteLength
    if (bytes > maxBytes) {
      text += decoder.decode(value.subarray(0, Math.max(0, value.byteLength - (bytes - maxBytes))), { stream: true })
      onLimit()
      await reader.cancel()
      return { text: text + decoder.decode(), truncated: true }
    }
    text += decoder.decode(value, { stream: true })
  }
  return { text: text + decoder.decode(), truncated: false }
}

export async function runCommand(
  command: string,
  args: string[],
  timeout = 5_000,
  signal?: AbortSignal,
  maxOutputBytes = 5 * 1024 * 1024,
): Promise<CommandResult> {
  const process = Bun.spawn([command, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, LC_ALL: "C", LANG: "C" },
    timeout,
    signal,
  })

  const [stdoutResult, stderrResult, exitCode] = await Promise.all([
    readLimited(process.stdout, maxOutputBytes, () => process.kill("SIGTERM")),
    readLimited(process.stderr, maxOutputBytes, () => process.kill("SIGTERM")),
    process.exited,
  ])

  const limitMessage = stdoutResult.truncated || stderrResult.truncated
    ? `\noutput exceeded ${maxOutputBytes} bytes and the process was stopped`
    : ""
  return {
    stdout: stdoutResult.text,
    stderr: stderrResult.text + limitMessage,
    exitCode,
  }
}

export function splitLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  const reader = stream.getReader()

  return {
    async *[Symbol.asyncIterator]() {
      let pending = ""
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          pending += decoder.decode(value, { stream: true })
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ""
          for (const line of lines) yield line
        }
        pending += decoder.decode()
        if (pending) yield pending
      } finally {
        reader.releaseLock()
      }
    },
  }
}
