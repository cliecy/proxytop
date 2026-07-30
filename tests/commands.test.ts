import { expect, test } from "bun:test"
import { runCommand } from "../src/commands"

test("bounds subprocess output and terminates an overflowing command", async () => {
  const result = await runCommand("/usr/bin/yes", [], 5_000, undefined, 1_024)
  expect(result.stdout.length).toBeLessThanOrEqual(1_024)
  expect(result.stderr).toContain("output exceeded 1024 bytes")
})
