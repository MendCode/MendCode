import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { expectedSum, parseSums, verifyChecksum } from "../packages/upgrade/src/checksum"
import { writeChecksums } from "./checksums"

test("SHA256SUMS covers payloads and bundles, and matches the upgrade verifier", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-sums-"))
  try {
    const names = ["mendcode-1.2.3-linux-x64", "SBOM.cdx.json", "mendcode-1.2.3-linux-x64.sigstore.json", "provenance.sigstore.json", "install.sh", "install.ps1"]
    for (const name of names) writeFileSync(path.join(dir, name), name)
    writeFileSync(path.join(dir, "SHA256SUMS.sigstore.json"), "manifest bundle excluded")
    await writeChecksums(dir)
    const text = await Bun.file(path.join(dir, "SHA256SUMS")).text()
    const sums = parseSums(text)
    expect([...sums.keys()]).toEqual([...names].sort())
    for (const name of names) verifyChecksum({ name, bytes: await Bun.file(path.join(dir, name)).bytes(), expected: expectedSum(sums, name) })
    await writeChecksums(dir)
    expect(await Bun.file(path.join(dir, "SHA256SUMS")).text()).toBe(text)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
