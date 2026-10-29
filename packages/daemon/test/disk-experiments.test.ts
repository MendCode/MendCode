import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createSynthetic } from "../../store/test/synthetic-data"

// Developer experiment only: zstd is optional, never an application dependency or a per-row production subprocess.
test.skipIf(!Bun.which("zstd"))("own-row dictionary and prefix delta experiments roundtrip held-out rows", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-dictionary-"))
  const synthetic = createSynthetic({ dir: path.join(dir, "data"), compress: true })
  try {
    const rows: string[] = []
    for (let i = 0; i < 12; i++) rows.push(...synthetic.store.engineMessages.load(synthetic.session(i), "native").map(row => JSON.stringify(row)))
    const files = rows.map((row, i) => {
      const file = path.join(dir, `row-${i}.json`)
      writeFileSync(file, row)
      return file
    })
    const dict = path.join(dir, "dictionary")
    const train = Bun.spawnSync(["zstd", "--train", ...files.slice(0, 640), "--maxdict=16384", "-o", dict], { stdout: "pipe", stderr: "pipe" })
    expect(train.exitCode).toBe(0)
    let standaloneBytes = 0
    let dictionaryBytes = 0
    let prefixDeltaBytes = 0
    let prior: Uint8Array = new Uint8Array()
    for (let i = 640; i < rows.length; i++) {
      const bytes = Buffer.from(rows[i]!)
      const standalone = Bun.zstdCompressSync(bytes, { level: 3 })
      standaloneBytes += Math.min(bytes.length, standalone.length + 9)
      const packed = Bun.spawnSync(["zstd", "-q", "-3", "-D", dict, "-c", files[i]!], { stdout: "pipe", stderr: "pipe" })
      expect(packed.exitCode).toBe(0)
      dictionaryBytes += Math.min(bytes.length, packed.stdout.length + 9)
      const packedFile = path.join(dir, "held-out.zst")
      writeFileSync(packedFile, packed.stdout)
      const restored = Bun.spawnSync(["zstd", "-q", "-d", "-D", dict, "-c", packedFile], { stdout: "pipe", stderr: "pipe" })
      expect(restored.exitCode).toBe(0)
      expect(restored.stdout).toEqual(bytes)
      let prefix = 0
      if (i % 16) while (prefix < bytes.length && prefix < prior.length && bytes[prefix] === prior[prefix]) prefix++
      const suffix = Bun.zstdCompressSync(bytes.subarray(prefix), { level: 3 })
      expect(Buffer.concat([prior.subarray(0, prefix), Bun.zstdDecompressSync(suffix)])).toEqual(bytes)
      prefixDeltaBytes += Math.min(bytes.length, standalone.length + 9, suffix.length + 17)
      prior = bytes
    }
    expect(dictionaryBytes).toBeLessThan(standaloneBytes)
    if (process.env.MEND_DISK_REPORT) console.log(JSON.stringify({ trainingRows: 640, heldOutRows: rows.length - 640, dictionaryOverhead: 16384, standaloneBytes, dictionaryBytes, prefixDeltaBytes }))
  } finally {
    synthetic.store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 60_000)
