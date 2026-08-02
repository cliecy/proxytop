import { mkdir, readFile, rename } from "node:fs/promises"
import { dirname, join } from "node:path"

export type Language = "en" | "zh"

export interface UserConfig {
  language: Language
}

const DEFAULT_CONFIG: UserConfig = { language: "en" }

export function configFilePath(): string {
  const configHome = Bun.env.XDG_CONFIG_HOME || join(Bun.env.HOME || ".", ".config")
  return join(configHome, "proxytop", "config.json")
}

export function parseConfig(value: string): UserConfig {
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== "object" || parsed === null) return { ...DEFAULT_CONFIG }
    const language = (parsed as { language?: unknown }).language
    return language === "zh" || language === "en" ? { language } : { ...DEFAULT_CONFIG }
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

export async function saveConfig(config: UserConfig): Promise<void> {
  const path = configFilePath()
  await mkdir(dirname(path), { recursive: true })
  const temporaryPath = `${path}.${process.pid}.tmp`
  await Bun.write(temporaryPath, `${JSON.stringify(config, null, 2)}\n`)
  await rename(temporaryPath, path)
}
