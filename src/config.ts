import { mkdir, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

export type Language = "en" | "zh"

export interface UserConfig {
  language: Language
  advancedMode: boolean
}

const DEFAULT_CONFIG: UserConfig = { language: "en", advancedMode: false }

let saveQueue: Promise<void> = Promise.resolve()

export function configFilePath(): string {
  const configHome = Bun.env.XDG_CONFIG_HOME || join(Bun.env.HOME || ".", ".config")
  return join(configHome, "proxytop", "config.json")
}

export function parseConfig(value: string): UserConfig {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_CONFIG }
    const record = parsed as { language?: unknown; advancedMode?: unknown }
    const language = record.language === "zh" || record.language === "en" ? record.language : DEFAULT_CONFIG.language
    const advancedMode = typeof record.advancedMode === "boolean" ? record.advancedMode : DEFAULT_CONFIG.advancedMode
    return { language, advancedMode }
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export async function loadConfig(): Promise<UserConfig> {
  try {
    return parseConfig(await readFile(configFilePath(), "utf8"))
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config: UserConfig): Promise<void> {
  const path = configFilePath()
  const contents = `${JSON.stringify(config, null, 2)}\n`
  const pending = saveQueue.then(async () => {
    await mkdir(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${process.pid}.tmp`
    await Bun.write(temporaryPath, contents)
    await rename(temporaryPath, path)
  })
  saveQueue = pending.catch(() => undefined)
  return pending
}
