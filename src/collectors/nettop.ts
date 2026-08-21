import type { FlowSample } from "../domain"
import { NettopParser } from "../parsers/nettop"

export class NettopCollector {
  private child?: Bun.Subprocess
  private terminal?: Bun.Terminal
  private stopped = false
  private started = false

  constructor(
    private readonly onSample: (sample: FlowSample) => void,
    private readonly onStatus: (status: string) => void,
  ) {}

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    void this.runLoop()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.child?.kill("SIGTERM")
  }

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const parser = new NettopParser()
      const decoder = new TextDecoder()
      let pending = ""
      let lastOutputAt = Date.now()
      this.onStatus("starting")
      this.terminal = new Bun.Terminal({
        cols: 240,
        rows: 80,
        data: (_terminal, data) => {
          if (this.stopped) return
          lastOutputAt = Date.now()
          pending += decoder.decode(data, { stream: true })
          const lines = pending.split(/\r?\n/)
          pending = lines.pop() ?? ""
          for (const line of lines) {
            const sample = parser.parse(line)
            if (sample && !this.stopped) this.onSample(sample)
          }
        },
      })
      this.child = Bun.spawn(
        ["/usr/bin/nettop", "-L", "0", "-n", "-x", "-s", "1"],
        {
          terminal: this.terminal,
          env: { ...Bun.env, LC_ALL: "C", LANG: "C", TERM: "dumb" },
        },
      )

      this.onStatus("active")
      const watchdog = setInterval(() => {
        if (this.child && Date.now() - lastOutputAt > 8_000) {
          this.onStatus("stalled; restarting")
          this.child.kill("SIGTERM")
        }
      }, 2_000)

      await this.child.exited
      clearInterval(watchdog)
      this.terminal.close()
      this.terminal = undefined
      this.child = undefined
      if (!this.stopped) {
        this.onStatus("restarting")
        await Bun.sleep(1_000)
      }
    }
    this.onStatus("stopped")
  }
}
