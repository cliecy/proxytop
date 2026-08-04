import { expect, test } from "bun:test"
import { parseConfig } from "../src/config"

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
