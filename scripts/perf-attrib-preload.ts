// Loaded with `BUN_OPTIONS="--preload scripts/perf-attrib-preload.ts"` by scripts/perf-attrib.ts, never by the product: a build
// carries no hook, so there is nothing to cost when it is not measured. On SIGUSR2 the process collects garbage, then writes
// `$PERF_ATTRIB_DIR/<pid>-<label>.json` with the JS heap by object type (`heapStats`), the modules it has loaded, the chunks embedded
// in the executable and, when the request says `snapshot`, the heap's bytes by constructor (a V8 heap snapshot, aggregated here).
// The request is `$PERF_ATTRIB_DIR/request`: `<label> [snapshot]`.
import { heapStats } from "bun:jsc"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

const dir = process.env.PERF_ATTRIB_DIR
if (dir) {
  process.on("SIGUSR2", () => {
    const [label = "x", mode] = readFileSync(path.join(dir, "request"), "utf8").trim().split(/\s+/)
    Bun.gc(true)
    const out: Record<string, unknown> = { pid: process.pid, label, heap: heapStats() }
    try { out.modules = Object.keys(require.cache).map((name) => (name.startsWith("/$bunfs/") ? [name, Bun.file(name).size] : [name, 0])) } catch {}
    try { out.embedded = Bun.embeddedFiles.map((file) => ({ name: (file as File).name, size: file.size })) } catch {}
    if (mode === "snapshot") {
      const snapshot = JSON.parse(Bun.generateHeapSnapshot("v8") as unknown as string) as { snapshot: { meta: { node_fields: string[]; node_types: string[][] } }; nodes: number[]; strings: string[] }
      const fields = snapshot.snapshot.meta.node_fields.length
      const at = (name: string) => snapshot.snapshot.meta.node_fields.indexOf(name)
      const [type, name, size] = [at("type"), at("name"), at("self_size")]
      const types = snapshot.snapshot.meta.node_types[0]!
      const by = new Map<string, { count: number; bytes: number }>()
      for (let i = 0; i < snapshot.nodes.length; i += fields) {
        const key = `${types[snapshot.nodes[i + type]!]}:${snapshot.strings[snapshot.nodes[i + name]!]!.slice(0, 60)}`
        const entry = by.get(key) ?? { count: 0, bytes: 0 }
        entry.count++
        entry.bytes += snapshot.nodes[i + size]!
        by.set(key, entry)
      }
      out.byConstructor = Object.fromEntries([...by].filter(([, v]) => v.bytes >= 2048))
    }
    const file = path.join(dir, `${process.pid}-${label}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify(out))
    renameSync(`${file}.tmp`, file)
  })
}
