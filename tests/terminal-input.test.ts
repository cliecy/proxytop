import { expect, test } from "bun:test"
import {
  isAllowedDashboardInputSequence,
  isMouseReportSequence,
  MOUSE_TRACKING_OFF,
} from "../src/terminal-input"

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

test("allows only dashboard keys outside search", () => {
  expect(isAllowedDashboardInputSequence("q", false)).toBe(true)
  expect(isAllowedDashboardInputSequence("\u001b[A", false)).toBe(true)
  expect(isAllowedDashboardInputSequence("x", false)).toBe(false)
  expect(isAllowedDashboardInputSequence("Q", false)).toBe(false)
  expect(isAllowedDashboardInputSequence("\u001b[<65;34;18M", false)).toBe(false)
  expect(isAllowedDashboardInputSequence("\u001b[B", false)).toBe(true)
  expect(isAllowedDashboardInputSequence("\u001bOB", false)).toBe(true)
})

test("allows search editing but still rejects terminal control reports", () => {
  expect(isAllowedDashboardInputSequence("a", true)).toBe(true)
  expect(isAllowedDashboardInputSequence("中", true)).toBe(true)
  expect(isAllowedDashboardInputSequence("\r", true)).toBe(true)
  expect(isAllowedDashboardInputSequence("\u007f", true)).toBe(true)
  expect(isAllowedDashboardInputSequence("\u001b[<65;34;18M", true)).toBe(false)
  expect(isAllowedDashboardInputSequence("\u001b[A", true)).toBe(false)
})
