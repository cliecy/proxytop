import { expect, test } from "bun:test"
import { redactProxyCredentials } from "../src/diagnostics"

test("redacts credentials from HTTP and SOCKS proxy URIs", () => {
  expect(redactProxyCredentials("http://alice:secret@proxy:8080")).toBe("http://***:***@proxy:8080")
  expect(redactProxyCredentials("socks5h://alice:secret@proxy:1080")).toBe("socks5h://***:***@proxy:1080")
  expect(redactProxyCredentials("https://token-only@proxy/?access_token=value")).toBe("https://***@proxy/?access_token=***")
})
