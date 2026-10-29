import type { PackageInfo, PackagesReport } from "@mendcode/protocol"
import { colorDepth, sgr } from "../../apps/cli/src/ui/theme"
import { createPackagesPageState, renderPackagesPage } from "../../apps/cli/src/view/packages-page"

const NOW = 1_800_000_000_000
const DAY = 24 * 3600 * 1000

function pkg(name: string, source: PackageInfo["source"], patch: Partial<PackageInfo> = {}): PackageInfo {
  return {
    name,
    source,
    key: `${source}:${name}`,
    dir: source === "user" ? `/Users/dev/.mendcode/packages/${name}` : `/Users/dev/Code/atlas/.mendcode/packages/${name}`,
    enabled: true,
    manifest: { name, version: "1.0.0", description: `Package ${name}` },
    install: { source: `github:acme/${name}`, commit: "9f2c1ab7d3e4550c8a1b", installedAt: NOW - 2 * DAY },
    contents: { tools: 1, skills: 0, commands: 0, themes: 0, mcp: false },
    ...patch,
  }
}

const report: PackagesReport = {
  directory: "/Users/dev/Code/atlas",
  packages: [
    pkg("toolbox", "user", {
      manifest: { name: "toolbox", version: "1.2.0", description: "Handy shell tools, review skills and slash commands for everyday work in any repository", author: "Acme Tools", homepage: "https://github.com/acme/toolbox", license: "MIT" },
      contents: { tools: 2, skills: 1, commands: 3, themes: 1, mcp: true },
    }),
    pkg("fjord-extras", "user", { manifest: { name: "fjord-extras", version: "0.4.1", description: "Two extra colour themes" }, contents: { tools: 0, skills: 0, commands: 0, themes: 2, mcp: false } }),
    pkg("atlas-deploy", "project", {
      manifest: { name: "atlas-deploy", version: "2.0.0-beta.3", description: "Deploy helpers for the atlas services" },
      install: { source: "/Users/dev/Code/atlas-packages/atlas-deploy", installedAt: NOW - 40 * 60 * 1000 },
      contents: { tools: 3, skills: 2, commands: 1, themes: 0, mcp: false },
    }),
    pkg("legacy-lint", "project", { enabled: false, manifest: { name: "legacy-lint", version: "0.9.0", description: "Old linter wrapper" }, contents: { tools: 1, skills: 0, commands: 1, themes: 0, mcp: false } }),
    pkg("half-installed", "user", {
      problem: "manifest.json: version must be a string (received number 2); the package cannot load until the manifest is fixed. Reinstall it or edit the file at the folder shown below.",
      manifest: undefined,
      install: undefined,
      contents: { tools: 0, skills: 0, commands: 0, themes: 0, mcp: false },
    } as Partial<PackageInfo>),
  ],
}

const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 35)
const selected = Number(process.argv[4] ?? 0)
const depth = colorDepth({ COLORTERM: "truecolor" })

for (const line of renderPackagesPage({ report, state: { ...createPackagesPageState(), selected }, width, height, now: NOW })) {
  let out = ""
  for (const span of line) {
    const style = sgr(span, depth)
    out += style ? `${style}${span.text}\x1b[0m` : span.text
  }
  process.stdout.write(`${out}\n`)
}
