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

export function hasPktapReadiness(text: string): boolean {
  return /\blistening on\b/.test(text)
}

export class PktapCollector {
  private child?: Bun.Subprocess<"inherit", "pipe", "pipe">
  private startPromise?: Promise<boolean>
  private stopped = false

  constructor(
    private readonly dropUser: string,
    private readonly onPacket: (packet: PacketEvidence) => void,
    private readonly onStatus: (status: string) => void,
  ) {}

  start(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    if (this.startPromise) return this.startPromise
    const pending = this.startInternal().finally(() => { if (this.startPromise === pending) this.startPromise = undefined })
    this.startPromise = pending
    return pending
  }

  private async startInternal(): Promise<boolean> {
    if (this.child) return true
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
    const child = this.child
    void this.drainStderr(child, resolveReady)
    void this.consume(child)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<boolean>((resolve) => { timeout = setTimeout(() => resolve(false), 10_000) })
    const started = await Promise.race([ready, this.child.exited.then(() => false), deadline])
    if (timeout) clearTimeout(timeout)
    if (!started || this.stopped) {
      this.child?.kill("SIGTERM")
      this.child = undefined
      this.onStatus(this.stopped ? "stopped" : "authorization failed")
      return false
    }
    this.onStatus("active")
    return true
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.child?.kill("SIGTERM")
    this.child = undefined
  }

  private async consume(child: Bun.Subprocess<"inherit", "pipe", "pipe">): Promise<void> {
    try {
      for await (const line of splitLines(child.stdout)) {
        const packet = parsePktapLine(line)
        if (packet && !this.stopped && this.child === child) this.onPacket(packet)
      }
      const exitCode = await child.exited
      if (!this.stopped && this.child === child) this.onStatus(exitCode === 0 ? "stopped" : `exited ${exitCode}`)
    } catch (error) {
      if (!this.stopped && this.child === child) this.onStatus(`error: ${error instanceof Error ? error.message : String(error)}`)
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
      if (!ready && hasPktapReadiness(text)) {
        ready = true
        resolveReady(true)
      }
      if (text.length > 2_000) text = text.slice(-1_000)
    }
    if (!ready) resolveReady(false)
  }
}
