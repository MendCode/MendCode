import { existsSync, lstatSync, readFileSync } from "node:fs"
import path from "node:path"

/**
 * The installer's receipt, `.mendcode-v2-install` beside the binary (scripts/install.sh, install.ps1; docs/install.md):
 * `schema`, `binary`, `sha256` and, since the installers take `--tier`, the starting `tier`. Uninstall checks the first
 * three; the first launch reads the tier. A receipt from an installer that predates `tier` has no such line.
 */
export const INSTALL_RECEIPT = ".mendcode-v2-install"
const INSTALL_TIERS = ["minimalist", "balanced", "full"] as const
export type InstallTier = (typeof INSTALL_TIERS)[number]
export type InstallReceipt = { binary: string; sha256: string; tier?: InstallTier }

const RECEIPT = /^schema=mendcode-v2\.install\.v1\nbinary=(mendcode(?:\.exe)?)\nsha256=([a-f0-9]{64})\n(?:tier=(minimalist|balanced|full)\n)?$/

/** The receipt's fields, or undefined when the text is not exactly a receipt. */
export function parseInstallReceipt(text: string): InstallReceipt | undefined {
  const match = RECEIPT.exec(text.replaceAll("\r\n", "\n"))
  if (!match) return undefined
  return { binary: match[1]!, sha256: match[2]!, ...(match[3] ? { tier: match[3] as InstallTier } : {}) }
}

/**
 * The tier the installer was asked for, or undefined when there is no receipt, it is not one, or it names none. The receipt is
 * looked for beside the running binary, then in `MENDCODE_INSTALL_DIR`, then in the installer's default directory; a program
 * run from source has only `MENDCODE_INSTALL_DIR`, so a development checkout never reads the real install's receipt.
 */
export function readInstallPreset({ runningBinary, env, home, platform }: { runningBinary?: string | undefined; env: Record<string, string | undefined>; home: string | undefined; platform: string }): InstallTier | undefined {
  const defaultDir = platform === "win32" ? (env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs", "mendcode") : undefined) : home ? path.join(home, ".local", "bin") : undefined
  const dirs = [runningBinary ? path.dirname(runningBinary) : undefined, env.MENDCODE_INSTALL_DIR || undefined, runningBinary ? defaultDir : undefined]
  for (const dir of dirs) {
    if (!dir) continue
    const file = path.join(dir, INSTALL_RECEIPT)
    try {
      if (!existsSync(file) || !lstatSync(file).isFile()) continue
      const receipt = parseInstallReceipt(readFileSync(file, "utf8"))
      if (receipt) return receipt.tier
    } catch { /* an unreadable receipt is no preset */ }
  }
  return undefined
}
