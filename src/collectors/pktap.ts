import { splitLines } from "../commands"
import type { PacketEvidence } from "../domain"
import { parsePktapLine } from "../parsers/pktap"

export async function authorizePacketCapture(): Promise<string | undefined> {
  const uid = process.getuid?.()
  if (uid === undefined || uid === 0) return undefined
  const identity = Bun.spawn(["/usr/bin/id", "-un", String(uid)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [userOutput, identityCode] = await Promise.all([identity.stdout.text(), identity.exited])
  const user = userOutput.trim()
  if (identityCode !== 0 || user === "root" || !/^[a-z_][a-z0-9_-]*$/i.test(user)) return undefined

  const authorization = Bun.spawn(["/usr/bin/sudo", "-v"], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  })
  return (await authorization.exited) === 0 ? user : undefined
}

export class PktapCollector {
  private child?: Bun.Subprocess<"inherit", "pipe", "pipe">

  constructor(
    private readonly dropUser: string,
    private readonly onPacket: (packet: PacketEvidence) => void,
    private readonly onStatus: (status: string) => void,
  ) {}

  async start(): Promise<boolean> {
    const tcpdumpArgs = [
      "/usr/sbin/tcpdump",
      "-i",
      "pktap,all",
      "-k",
      "INPSD",
      "-l",
      "-n",
      "-q",
      "-tt",
      "-s",
      "64",
    ]
    tcpdumpArgs.push("-Z", this.dropUser)
    tcpdumpArgs.push("not", "port", "53", "and", "not", "port", "5353", "and", "not", "port", "853")
    this.child = Bun.spawn(
      ["/usr/bin/sudo", "-N", "--", ...tcpdumpArgs],
      { stdin: "inherit", stdout: "pipe", stderr: "pipe" },
    )
    this.onStatus("authorizing")
    let resolveReady: (ready: boolean) => void = () => {}
    const ready = new Promise<boolean>((resolve) => {
      resolveReady = resolve
    })
    void this.drainStderr(this.child, resolveReady)
    void this.consume()
    const started = await Promise.race([
      ready,
      this.child.exited.then(() => false),
    ])
    this.onStatus(started ? "active" : "authorization failed")
    return started
  }

  stop(): void {
    this.child?.kill("SIGTERM")
  }

  private async consume(): Promise<void> {
    if (!this.child) return
    try {
      for await (const line of splitLines(this.child.stdout)) {
        const packet = parsePktapLine(line)
        if (packet) this.onPacket(packet)
      }
      const exitCode = await this.child.exited
      this.onStatus(exitCode === 0 ? "stopped" : `exited ${exitCode}`)
    } catch (error) {
      this.onStatus(`error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async drainStderr(
    child: Bun.Subprocess<"inherit", "pipe", "pipe">,
    resolveReady: (ready: boolean) => void,
  ): Promise<void> {
    const reader = child.stderr.getReader()
    const decoder = new TextDecoder()
    let text = ""
    let ready = false
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      if (!ready) process.stderr.write(value)
      text += decoder.decode(value, { stream: true })
      if (!ready && /\blistening on\b/.test(text)) {
        ready = true
        resolveReady(true)
      }
      if (text.length > 2_000) text = text.slice(-1_000)
    }
    if (!ready) resolveReady(false)
  }
}
