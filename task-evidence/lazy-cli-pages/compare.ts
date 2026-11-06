/** Read split-build metadata only; never import or launch MendCode. Bytes are decimal, not KiB. */
type Meta = {
  inputs: Record<string, { bytes: number }>
  outputs: Record<string, { bytes: number; entryPoint?: string; inputs: Record<string, unknown>; imports: Array<{ path: string; kind: string }> }>
}

// Dynamic roots required by a solo terminal, not every optional import in the executable.
const roots = ["apps/cli/src/entry.ts", "apps/cli/src/main.ts", "apps/cli/src/ui/app.ts", "apps/cli/src/ui/screen.ts", "apps/cli/src/solo.ts", "packages/daemon/src/main.ts"]
function graph(meta: Meta) {
  const chunks = new Set<string>()
  function visit(name: string) {
    const output = meta.outputs[name]
    if (!output || chunks.has(name)) return
    chunks.add(name)
    for (const edge of output.imports) if (edge.kind !== "dynamic-import") visit(edge.path)
  }
  for (const [name, output] of Object.entries(meta.outputs)) if (output.entryPoint && roots.includes(output.entryPoint)) visit(name)
  const inputs = [...new Set([...chunks].flatMap(name => Object.keys(meta.outputs[name]!.inputs)))]
  return { chunks: chunks.size, bytes: [...chunks].reduce((sum, name) => sum + meta.outputs[name]!.bytes, 0), inputs }
}

const before: Meta = await Bun.file(process.argv[2] ?? "dist/probe/meta-before.json").json()
const after: Meta = await Bun.file(process.argv[3] ?? "dist/probe/meta.json").json()
const a = graph(before), b = graph(after)
const left = a.inputs.filter(name => !b.inputs.includes(name)).map(file => ({ file, sourceBytes: before.inputs[file]!.bytes }))
console.log(JSON.stringify({
  roots, before: { chunks: a.chunks, bytes: a.bytes }, after: { chunks: b.chunks, bytes: b.bytes },
  savedBytes: a.bytes - b.bytes, removedSourceBytes: left.reduce((sum, input) => sum + input.sourceBytes, 0),
  left, added: b.inputs.filter(name => !a.inputs.includes(name)),
}, null, 2))
