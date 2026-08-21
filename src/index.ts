#!/usr/bin/env bun

import { loadConfig } from "./config"
import { runDaemon } from "./daemon"
import { checkDns, checkGit, checkSsh, checkUrl, inspectApp, runDoctor } from "./diagnostics"
import { ProxyEngine } from "./engine"
import { GeoResolver, geoStatus, updateGeoDatabase } from "./geo"
import { FlowStore } from "./store"
import { Dashboard } from "./ui"

function printHelp(): void {
  console.log(`proxytop - observe macOS proxy, tunnel, and process traffic

Usage:
  proxytop [--privileged]
  proxytop doctor
  proxytop check git [repository-url]
  proxytop check ssh <host>
  proxytop check url <url>
  proxytop check dns <host>
  proxytop inspect <app-name>
  proxytop geo status
  proxytop geo update
  proxytop daemon [--privileged]

Options:
  --privileged  Enable diagnostic Apple pktap metadata counting; does not affect path verdicts
  -h, --help    Show this help`)
}

async function runCheck(args: string[]): Promise<number> {
  const kind = args[0]
  const target = args[1]
  if (kind === "git" && args.length <= 2) return checkGit(target)
  if (kind === "ssh" && target && args.length === 2) return checkSsh(target)
  if (kind === "url" && target && args.length === 2) return checkUrl(target)
  if (kind === "dns" && target && args.length === 2) return checkDns(target)
  console.error("Invalid check command. Run proxytop --help for usage.")
  return 2
}

async function main(): Promise<number> {
  const args = Bun.argv.slice(2)
  const clashControllerUrl = Bun.env.PROXYTOP_CLASH_CONTROLLER
  const clashSecret = Bun.env.PROXYTOP_CLASH_SECRET
  delete Bun.env.PROXYTOP_CLASH_SECRET
  if (args.includes("--help") || args.includes("-h")) {
    printHelp()
    return 0
  }
  if (args[0] === "doctor" && args.length === 1) return runDoctor()
  if (args[0] === "check") return runCheck(args.slice(1))
  if (args[0] === "inspect" && args[1] && args.length === 2) {
    return inspectApp(args[1], 4_000, clashControllerUrl, clashSecret)
  }
  if (args[0] === "geo" && args[1] === "status" && args.length === 2) return geoStatus()
  if (args[0] === "geo" && args[1] === "update" && args.length === 2) return updateGeoDatabase()
  if (args[0] === "daemon") {
    const rest = args.slice(1)
    const privileged = rest.includes("--privileged")
    const supervised = rest.includes("--supervised")
    const unknown = rest.filter((arg) => arg !== "--privileged" && arg !== "--supervised")
    if (unknown.length > 0) {
      console.error("Unknown daemon arguments. Run proxytop --help for usage.")
      return 2
    }
    return runDaemon({ privileged, supervised, clashControllerUrl, clashSecret })
  }

  const dashboardArgs = args.filter((arg) => arg !== "--privileged")
  if (dashboardArgs.length > 0 || args.filter((arg) => arg === "--privileged").length > 1) {
    console.error("Unknown arguments. Run proxytop --help for usage.")
    return 2
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("proxytop requires an interactive terminal. Use 'proxytop doctor' for a non-interactive check.")
    return 2
  }

  const privileged = args.includes("--privileged")
  const geo = new GeoResolver()
  await geo.initialize()
  const config = await loadConfig()
  const store = new FlowStore()
  store.setRegionLookup(geo.lookup)
  const dashboard = new Dashboard(store, geo.status, config.language, config.advancedMode)
  const engine = new ProxyEngine(store, geo, {
    privileged,
    clashControllerUrl,
    clashSecret,
    onPacket: (packet) => dashboard.addPacket(packet),
    onStatus: (statuses) => {
      dashboard.setNettopStatus(statuses.nettop)
      dashboard.setPktapStatus(statuses.pktap)
      dashboard.setClashStatus(statuses.clash)
    },
  })
  if (!(await engine.start())) {
    console.error("Packet capture authorization failed; start without --privileged for rootless mode.")
    return 1
  }
  try {
    await dashboard.run(() => {})
  } finally {
    engine.stop()
  }
  return 0
}

process.exitCode = await main()
