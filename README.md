# proxytop

[![CI](https://github.com/cliecy/proxytop/actions/workflows/ci.yml/badge.svg)](https://github.com/cliecy/proxytop/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/proxytop.svg)](https://www.npmjs.com/package/proxytop)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`proxytop` is a macOS terminal dashboard for answering whether each application is using a local proxy, VPN/TUN, overlay network, or physical interface.

It correlates system HTTP/HTTPS/SOCKS settings, local listeners, configured VPN services, active `utun` devices, DNS scopes, ZeroTier `feth` devices, routes, and per-process `nettop` connections. It does not inspect TLS payloads or modify proxy settings.

## Requirements

- macOS, currently tested against macOS 27 on Apple Silicon
- Bun 1.3 or newer

## Install

Run without installing:

```bash
bunx proxytop
```

Or install globally:

```bash
bun add --global proxytop
proxytop
```

Run from source:

```bash
bun install
bun run start
```

Optional Apple pktap metadata capture:

```bash
proxytop --privileged
```

Only the fixed `tcpdump` child process receives elevated privileges. It is launched with sudo's no-timestamp-update mode and drops back to the invoking user after opening the capture interface. It excludes common plaintext DNS ports and limits each in-memory capture to the first 64 bytes. `proxytop` retains only process, PID, interface, direction, and counters; raw packet lines and payloads are not saved to disk. The privileged `tcpdump` process still temporarily sees packet headers and potentially a few application bytes, so use this mode only when needed.

## Diagnostics

```bash
proxytop doctor
proxytop check git
proxytop check git https://github.com/owner/repository.git
proxytop check ssh github.com
proxytop check url https://example.com
proxytop check dns example.com
proxytop inspect opencode
```

`inspect` passively observes existing traffic for four seconds. Network probes only run when a `check` command is invoked.

## Offline Country Data

Country lookup is disabled until its offline database is explicitly installed:

```bash
proxytop geo update
proxytop geo status
```

The update downloads the `server-country` database used by `ip-location-api` into a private fixed cache directory. Its updater is launched directly with an argument array rather than through the dependency's shell-building wrapper. Normal monitoring performs local lookups and does not send observed destination IPs to a geolocation service. The displayed value is the target/remote IP's allocation country, not a guaranteed VPN exit location or exact physical location.

## Clash-Compatible Controller

`proxytop` automatically connects when a known Clash/Mihomo process owns a standard loopback controller port (`9090` or `9097`). A custom controller can be supplied without storing its secret:

```bash
export PROXYTOP_CLASH_CONTROLLER=http://127.0.0.1:9090
read -s PROXYTOP_CLASH_SECRET
export PROXYTOP_CLASH_SECRET
proxytop
```

When a secret is present, an explicit HTTPS controller URL is required. For a local controller, use a literal loopback IP; proxytop verifies the exact listener PID, user, process, IP, and port before every request and stops if ownership changes. Controller requests use direct sockets and never ambient HTTP proxies. The secret is removed from the environment before system collectors and diagnostics spawn child processes. Secret-free loopback controllers may still use HTTP.

When available, the Apps view associates controller connections by source IP, port, transport, and process, then adds the exact destination hostname, rule, and proxy chain. Without a controller, macOS can still prove the local proxy port or TUN owner but cannot reliably recover the selected node or rule. Hiddify builds that expose a Clash-compatible API can use the same settings.

## Keys

- `1`: application verdicts
- `2`: complete proxy/VPN/tunnel topology
- `3`: raw connection evidence
- `4`: diagnostics and uncertainty
- `/`: filter by application or endpoint
- `j`, `k`, or arrow keys: select or scroll
- `s`: sort by speed, process, or path
- `p` or Space: pause rendering
- `q`: quit

## Path Labels

- `PROXY`: application connected to a known local proxy listener
- `TUN`: application traffic uses the active VPN-backed tunnel
- `DIRECT`: application traffic uses a physical interface without an observed local proxy hop
- `OUTBOUND`: proxy engine traffic leaving through a physical interface
- `OVERLAY`: traffic on an attributed overlay such as ZeroTier
- `LAN`: loopback, private, link-local, or local traffic
- `UNKNOWN`: insufficient evidence to make a reliable claim

Application verdicts:

- `PROXIED`: an explicit local proxy hop or attributed VPN/TUN path was observed
- `DIRECT`: a physical-interface connection with no local proxy hop was observed
- `MIXED`: the application currently has more than one route class, such as proxy plus direct
- `OVERLAY`: the application is using an attributed overlay such as ZeroTier
- `ENGINE`: the process is a proxy/VPN engine creating outer connections
- `UNKNOWN`: evidence is insufficient for a reliable claim

`DIRECT` does not automatically mean a leak. Some applications and destinations intentionally bypass a proxy. For local HTTP/SOCKS proxies and packet tunnels, macOS does not expose a reliable application-to-final-node join. In those cases proxytop reports the proven local port or TUN owner and marks the final destination/country as hidden instead of guessing. Clash/Mihomo-compatible controller integration would be needed to show exact rule and node chains; Shadowrocket has no equivalent stable public API.

The header's `WAN observed` rate counts only physical-interface direct and proxy-engine outer sockets. It intentionally excludes loopback proxy copies and TUN copies to avoid double counting the same traffic.
