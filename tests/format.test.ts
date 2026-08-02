import { expect, test } from "bun:test"
import { pathLabel } from "../src/format"

test("formats path labels in English and Chinese", () => {
  expect(pathLabel("LOCAL_PROXY")).toBe("PROXY")
  expect(pathLabel("LOCAL_PROXY", "zh")).toBe("代理")
  expect(pathLabel("TUNNELED", "zh")).toBe("隧道")
})
