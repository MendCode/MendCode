import path from "node:path"
import type { Channel } from "./releases"
import type { UpgradeFs } from "./ports"
import { CHANNELS, DEFAULT_CHANNEL, STATE_FILE } from "./settings"

/** `<dataDir>/upgrade.json`: the remembered channel and the last upgrade run. */
export type UpgradeState = { channel: Channel; lastCheckAt: number | null; lastVersion: string | null }

export const defaultState = (): UpgradeState => ({ channel: DEFAULT_CHANNEL, lastCheckAt: null, lastVersion: null })

/** A missing or damaged file is the default state; it is only ever rewritten by a successful upgrade run. */
export async function readState({ fs, dataDir }: { fs: UpgradeFs; dataDir: string }): Promise<UpgradeState> {
  const text = await fs.readText(path.join(dataDir, STATE_FILE)).catch(() => undefined)
  if (text === undefined) return defaultState()
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return defaultState()
  }
  if (typeof json !== "object" || json === null) return defaultState()
  const record = json as Record<string, unknown>
  return {
    channel: CHANNELS.includes(record.channel as Channel) ? (record.channel as Channel) : DEFAULT_CHANNEL,
    lastCheckAt: typeof record.lastCheckAt === "number" && Number.isFinite(record.lastCheckAt) ? record.lastCheckAt : null,
    lastVersion: typeof record.lastVersion === "string" && /^(?:v\d{1,9}\.\d{1,9}\.\d{1,9}(?:-(?:beta\.\d{1,9}|nightly\.\d{8}\.[1-9]\d{0,8}))?|dev-[a-f0-9]{7,40})$/.test(record.lastVersion) ? record.lastVersion : null,
  }
}

export async function writeState({ fs, dataDir, state }: { fs: UpgradeFs; dataDir: string; state: UpgradeState }) {
  const file = path.join(dataDir, STATE_FILE)
  const staged = `${file}.tmp`
  await fs.mkdir(dataDir)
  try {
    await fs.writeFile(staged, new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`))
    await fs.rename(staged, file)
  } catch (error) {
    await fs.remove(staged).catch(() => undefined)
    throw error
  }
}
