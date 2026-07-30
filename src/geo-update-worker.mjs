import { join } from "node:path"
import { pathToFileURL } from "node:url"

const apiDir = process.env.ILA_API_DIR
if (!apiDir) throw new Error("ILA_API_DIR is required")

const { update } = await import(pathToFileURL(join(apiDir, "src", "db.mjs")).href)
await update()
