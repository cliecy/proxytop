import { access, mkdir, open, readdir, rename, rm, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { isIP } from "node:net"
import { fileURLToPath } from "node:url"

type LookupResult = { country?: string } | null
type GeoModule = {
  lookup(ip: string): LookupResult | Promise<LookupResult>
  reload(settings?: Record<string, unknown>): Promise<void> | void
}

function directories(): { dataDir: string; tmpDataDir: string; databaseFile: string } {
  const root = join(homedir(), ".cache")
  const dataDir = join(root, "proxytop", "geo")
  return {
    dataDir,
    tmpDataDir: join(root, "proxytop", "geo-tmp"),
    databaseFile: join(dataDir, "g", "4-1.dat"),
  }
}

function packageDirectory(): string | undefined {
  try {
    const modulePath = fileURLToPath(import.meta.resolve("ip-location-api"))
    return dirname(dirname(modulePath))
  } catch {
    return undefined
  }
}

function configureEnvironment(dataDir: string, tmpDataDir: string, skipInitialReload: boolean): void {
  for (const key of Object.keys(Bun.env)) {
    if (key.startsWith("ILA_")) delete Bun.env[key]
  }
  Bun.env.ILA_DATA_DIR = dataDir
  Bun.env.ILA_TMP_DATA_DIR = tmpDataDir
  Bun.env.ILA_IP_LOCATION_DB = "server"
  Bun.env.ILA_FIELDS = "country"
  Bun.env.ILA_AUTO_UPDATE = "false"
  Bun.env.ILA_SILENT = "true"
  Bun.env.ILA_SKIP_INITIAL_RELOAD = skipInitialReload ? "true" : "false"
  const apiDir = packageDirectory()
  if (apiDir) Bun.env.ILA_API_DIR = apiDir
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directorySize(child)
    else if (entry.isFile()) total += (await stat(child)).size
  }
  return total
}

export class GeoResolver {
  private module?: GeoModule
  status = "not installed"

  async initialize(): Promise<void> {
    const paths = directories()
    try {
      await access(paths.databaseFile)
    } catch {
      this.status = "not installed (run: proxytop geo update)"
      return
    }

    configureEnvironment(paths.dataDir, paths.tmpDataDir, false)
    try {
      this.module = (await import("ip-location-api")) as unknown as GeoModule
    } catch (error) {
      this.status = `offline country DB unavailable (${error instanceof Error ? error.message : String(error)})`
      return
    }
    this.status = "offline country DB ready"
  }

  lookup = (ip: string): string | undefined => {
    if (!this.module || isIP(ip) === 0) return undefined
    const result = this.module.lookup(ip)
    if (result instanceof Promise) return undefined
    return result?.country || undefined
  }
}

export async function updateGeoDatabase(): Promise<number> {
  const paths = directories()
  const root = dirname(paths.dataDir)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const stagingData = join(root, `geo-staging-${process.pid}`)
  const stagingTmp = join(root, `geo-tmp-staging-${process.pid}`)
  await rm(stagingData, { recursive: true, force: true })
  await rm(stagingTmp, { recursive: true, force: true })
  await mkdir(stagingData, { recursive: true, mode: 0o700 })
  await mkdir(stagingTmp, { recursive: true, mode: 0o700 })
  const lockPath = join(root, "geo-update.lock")
  let lock: Awaited<ReturnType<typeof open>>
  try {
    lock = await open(lockPath, "wx", 0o600)
  } catch {
    console.error("Another geo database update appears to be running.")
    return 1
  }
  configureEnvironment(stagingData, stagingTmp, true)
  try {
    const apiDir = packageDirectory()
    if (!apiDir) throw new Error("Unable to resolve ip-location-api")
    const script = join(import.meta.dir, "geo-update-worker.mjs")
    console.log("Downloading and building the offline server-country database...")
    const child = Bun.spawn([process.execPath, script], {
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      env: { ...Bun.env },
      timeout: 600_000,
    })
    let oversized = false
    let sizeCheckRunning = false
    const sizeTimer = setInterval(async () => {
      if (sizeCheckRunning) return
      sizeCheckRunning = true
      try {
        const size = await directorySize(stagingData) + await directorySize(stagingTmp)
        if (size > 200 * 1024 * 1024) {
          oversized = true
          child.kill("SIGTERM")
        }
      } finally {
        sizeCheckRunning = false
      }
    }, 500)
    const exitCode = await child.exited
    clearInterval(sizeTimer)
    if (exitCode !== 0 || oversized) {
      console.error(oversized ? "Geo database update exceeded the 200 MiB safety limit." : `Geo database update failed with exit code ${exitCode}.`)
      return exitCode || 1
    }
    const fieldDir = join(stagingData, "g")
    for (const file of ["4-1.dat", "4-2.dat", "4-3.dat", "6-1.dat", "6-2.dat", "6-3.dat"]) {
      const info = await stat(join(fieldDir, file))
      if (!info.isFile() || info.size === 0) throw new Error(`Geo database is missing ${file}`)
    }
    const backup = join(root, `geo-backup-${process.pid}`)
    await rm(backup, { recursive: true, force: true })
    await rename(paths.dataDir, backup).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error
    })
    try {
      await rename(stagingData, paths.dataDir)
    } catch (error) {
      await rename(backup, paths.dataDir).catch(() => {})
      throw error
    }
    await rm(backup, { recursive: true, force: true })
    configureEnvironment(paths.dataDir, paths.tmpDataDir, false)
    const module = (await import("ip-location-api")) as unknown as GeoModule
    await module.reload()
    console.log(`Geo database ready at ${paths.dataDir}`)
    return 0
  } finally {
    await rm(stagingData, { recursive: true, force: true })
    await rm(stagingTmp, { recursive: true, force: true })
    await lock.close()
    await unlink(lockPath).catch(() => {})
  }
}

export async function geoStatus(): Promise<number> {
  const paths = directories()
  try {
    await access(paths.databaseFile)
    console.log(`Offline country database: ready (${paths.dataDir})`)
  } catch {
    console.log("Offline country database: not installed")
    console.log("Run: bun run src/index.ts geo update")
  }
  return 0
}
