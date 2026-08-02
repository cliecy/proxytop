import { expect, test } from "bun:test"
import { isMouseReportSequence, MOUSE_TRACKING_OFF } from "../src/terminal-input"

test("recognizes supported terminal mouse report sequences", () => {
  expect(isMouseReportSequence("\u001b[<35;10;5M")).toBe(true)
  expect(isMouseReportSequence("\u001b[<35;10;5m")).toBe(true)
  expect(isMouseReportSequence("\u001b[35;10;5M")).toBe(true)
  expect(isMouseReportSequence("\u001b[M#((")).toBe(true)
})

test("does not swallow ordinary keyboard escape sequences", () => {
  expect(isMouseReportSequence("\u001b[A")).toBe(false)
  expect(isMouseReportSequence("\u001b[1;5D")).toBe(false)
  expect(MOUSE_TRACKING_OFF).toContain("\u001b[?1003l")
})
