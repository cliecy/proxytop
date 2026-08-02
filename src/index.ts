#!/usr/bin/env bun

import { NettopCollector } from "./collectors/nettop"
import { ClashCollector, controllerOwnerForUrl, discoverClashController } from "./collectors/clash"
import { authorizePacketCapture, PktapCollector } from "./collectors/pktap"
import { collectNetworkSnapshot } from "./collectors/system"
import { loadConfig } from "./config"
import { checkDns, checkGit, checkSsh, checkUrl, inspectApp, runDoctor } from "./diagnostics"
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

Options:
  --privileged  Enable Apple pktap metadata capture through a scoped sudo tcpdump process
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
  let packetCaptureUser: string | undefined
  if (privileged) {
    packetCaptureUser = await authorizePacketCapture()
    if (!packetCaptureUser) {
      console.error("sudo authorization or safe privilege-drop user detection failed; start without --privileged.")
      return 1
    }
  }

  const geo = new GeoResolver()
  await geo.initialize()
  const config = await loadConfig()
  const store = new FlowStore()
  store.setRegionLookup(geo.lookup)
  const initialSnapshot = await collectNetworkSnapshot()
  store.setSnapshot(initialSnapshot)
  const dashboard = new Dashboard(store, geo.status, config.language)
  const nettop = new NettopCollector(
    (sample) => store.upsert(sample),
    (status) => dashboard.setNettopStatus(status),
  )
  const pktap = privileged
    ? new PktapCollector(
        packetCaptureUser!,
        (packet) => dashboard.addPacket(packet),
        (status) => dashboard.setPktapStatus(status),
      )
    : undefined
  let clash: ClashCollector | undefined
  const ensureClashCollector = (snapshot: typeof initialSnapshot): void => {
    if (clash) return
    const clashUrl = discoverClashController(snapshot.listeners, clashControllerUrl, Boolean(clashSecret))
    if (!clashUrl) {
      if (clashSecret && !clashControllerUrl) dashboard.setClashStatus("explicit URL required for secret")
      else if (clashControllerUrl) dashboard.setClashStatus("invalid controller URL")
      return
    }
    clash = new ClashCollector(
      clashUrl,
      clashSecret,
      clashSecret ? controllerOwnerForUrl(clashUrl, snapshot.listeners) : undefined,
      (controllerSnapshot) => store.setControllerSnapshot(controllerSnapshot),
      (status) => dashboard.setClashStatus(status),
    )
    clash.start()
  }
  ensureClashCollector(initialSnapshot)

  let snapshotAbort: AbortController | undefined
  let snapshotPromise: Promise<void> | undefined
  const snapshotTimer = setInterval(() => {
    if (snapshotPromise) return
    const controller = new AbortController()
    snapshotAbort = controller
    const pending = collectNetworkSnapshot(controller.signal)
      .then((snapshot) => {
        store.setSnapshot(snapshot)
        ensureClashCollector(snapshot)
      })
      .catch((error) => {
        if (!controller.signal.aborted) dashboard.setNettopStatus(`snapshot error: ${String(error).slice(0, 80)}`)
      })
      .finally(() => {
        if (snapshotPromise === pending) {
          snapshotPromise = undefined
          snapshotAbort = undefined
        }
      })
    snapshotPromise = pending
  }, 5_000)
  const tickTimer = setInterval(() => store.tick(), 1_000)

  nettop.start()
  if (pktap && !(await pktap.start())) {
    nettop.stop()
    clash?.stop()
    clearInterval(snapshotTimer)
    clearInterval(tickTimer)
    snapshotAbort?.abort()
    await snapshotPromise?.catch(() => {})
    console.error("Packet capture authorization failed; start without --privileged for rootless mode.")
    return 1
  }
  try {
    await dashboard.run(() => {})
  } finally {
    clearInterval(snapshotTimer)
    clearInterval(tickTimer)
    snapshotAbort?.abort()
    await snapshotPromise?.catch(() => {})
    nettop.stop()
    pktap?.stop()
    clash?.stop()
  }
  return 0
}

process.exitCode = await main()
