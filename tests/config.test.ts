import { expect, test } from "bun:test"
import { parseConfig } from "../src/config"

test("loads supported language settings", () => {
  expect(parseConfig('{"language":"zh"}')).toEqual({ language: "zh" })
  expect(parseConfig('{"language":"en"}')).toEqual({ language: "en" })
})

test("falls back to English for missing or invalid settings", () => {
  expect(parseConfig("{}")).toEqual({ language: "en" })
  expect(parseConfig('{"language":"ja"}')).toEqual({ language: "en" })
  expect(parseConfig("not json")).toEqual({ language: "en" })
})
