import { expect, spyOn, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseConfig, saveConfig } from "../src/config"

test("loads supported language settings", () => {
  expect(parseConfig('{"language":"zh"}')).toEqual({ language: "zh", advancedMode: false })
  expect(parseConfig('{"language":"en"}')).toEqual({ language: "en", advancedMode: false })
})

test("loads advanced mode setting", () => {
  expect(parseConfig('{"language":"en","advancedMode":true}')).toEqual({ language: "en", advancedMode: true })
  expect(parseConfig('{"advancedMode":false}')).toEqual({ language: "en", advancedMode: false })
})

test("falls back to English for missing or invalid settings", () => {
  expect(parseConfig("{}")).toEqual({ language: "en", advancedMode: false })
  expect(parseConfig('{"language":"ja"}')).toEqual({ language: "en", advancedMode: false })
  expect(parseConfig("not json")).toEqual({ language: "en", advancedMode: false })
})

test.serial("serializes concurrent configuration writes", async () => {
  const originalConfigHome = Bun.env.XDG_CONFIG_HOME
  const configHome = await mkdtemp(join(tmpdir(), "proxytop-config-"))
  const originalWrite = Bun.write.bind(Bun)
  const firstEntered = Promise.withResolvers<void>()
  const releaseFirst = Promise.withResolvers<void>()
  let writeCount = 0
  let activeWrites = 0
  let maximumActiveWrites = 0
  Bun.env.XDG_CONFIG_HOME = configHome
  const writeSpy = spyOn(Bun, "write").mockImplementation(async (destination, input) => {
    writeCount += 1
    activeWrites += 1
    maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites)
    try {
      if (writeCount === 1) {
        firstEntered.resolve()
        await releaseFirst.promise
      }
      return await originalWrite(String(destination), String(input))
    } finally {
      activeWrites -= 1
    }
  })

  try {
    const firstSave = saveConfig({ language: "en", advancedMode: false })
    await firstEntered.promise
    const secondSave = saveConfig({ language: "zh", advancedMode: true })
    await Promise.resolve()
    expect(writeCount).toBe(1)

    releaseFirst.resolve()
    await Promise.all([firstSave, secondSave])

    expect(maximumActiveWrites).toBe(1)
    expect(JSON.parse(await readFile(join(configHome, "proxytop", "config.json"), "utf8"))).toEqual({
      language: "zh",
      advancedMode: true,
    })
  } finally {
    releaseFirst.resolve()
    writeSpy.mockRestore()
    if (originalConfigHome === undefined) delete Bun.env.XDG_CONFIG_HOME
    else Bun.env.XDG_CONFIG_HOME = originalConfigHome
    await rm(configHome, { recursive: true, force: true })
  }
})

test.serial("continues configuration writes after a failure", async () => {
  const originalConfigHome = Bun.env.XDG_CONFIG_HOME
  const configHome = await mkdtemp(join(tmpdir(), "proxytop-config-"))
  const originalWrite = Bun.write.bind(Bun)
  let failNextWrite = true
  let restored = false
  Bun.env.XDG_CONFIG_HOME = configHome
  const writeSpy = spyOn(Bun, "write").mockImplementation((destination, input) => {
    if (failNextWrite) {
      failNextWrite = false
      return Promise.reject(new Error("write failed"))
    }
    return originalWrite(String(destination), String(input))
  })

  try {
    await expect(saveConfig({ language: "en", advancedMode: false })).rejects.toThrow("write failed")
    writeSpy.mockRestore()
    restored = true

    await saveConfig({ language: "zh", advancedMode: true })
    expect(JSON.parse(await readFile(join(configHome, "proxytop", "config.json"), "utf8"))).toEqual({
      language: "zh",
      advancedMode: true,
    })
  } finally {
    if (!restored) writeSpy.mockRestore()
    if (originalConfigHome === undefined) delete Bun.env.XDG_CONFIG_HOME
    else Bun.env.XDG_CONFIG_HOME = originalConfigHome
    await rm(configHome, { recursive: true, force: true })
  }
})
