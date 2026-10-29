import { chmodSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_SERVERS, type LspServerSpec } from "../src/registry"
import { OTHER_SERVERS } from "../src/other-presets"
import { FAKE_LSP, put } from "./helpers"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export function installedFake(root: string, name: string, content = `exec ${quote(process.execPath)} ${quote(FAKE_LSP)}\n`) {
  const binary = put({ root, path: name, content: `#!/bin/sh\n${content}` })
  chmodSync(binary, 0o755)
  return binary
}

export function otherFixture(directory: string, id: string) {
  const spec = OTHER_SERVERS.find((server) => server.id === id)!
  const filePath = spec.filenames?.[0] ?? `src/sample${spec.extensions[0]}`
  put({ root: directory, path: filePath, content: "function execute() {}\n" })
  if (spec.rootMarkers[0]) put({ root: directory, path: spec.rootMarkers[0].replace("*", "sample"), content: "{}" })
  installedFake(directory, `node_modules/.bin/${spec.command[0]}`)
  const env: Record<string, string> = { FAKE_LOG: join(directory, "lsp.log") }
  if (id === "jdtls") {
    env.JAVA_HOME = join(directory, "java-home")
    installedFake(env.JAVA_HOME, process.platform === "win32" ? "bin/java.exe" : "bin/java", "printf '%s\\n' 'openjdk version \"21.0.4\"'\n")
  }
  if (id === "razor") {
    env.VSCODE_EXTENSIONS = join(directory, "vscode-extensions")
    razorFixture(env.VSCODE_EXTENSIONS)
  }
  put({ root: directory, path: ".mendcode/lsp.json", content: JSON.stringify({ servers: Object.fromEntries(DEFAULT_SERVERS.map((server) => [server.id, server.id === id ? { disabled: false, env } : { disabled: true }])) }) })
  return { spec: { ...spec, env, enabled: true } satisfies LspServerSpec, filePath }
}

export function razorFixture(root: string, version = "1.0.0") {
  const directory = `ms-dotnettools.csharp-${version}/.razorExtension`
  return ["Microsoft.CodeAnalysis.Razor.Compiler.dll", "Targets/Microsoft.NET.Sdk.Razor.DesignTime.targets", "Microsoft.VisualStudioCode.RazorExtension.dll"].map((file) => put({ root, path: `${directory}/${file}`, content: "" }))
}
