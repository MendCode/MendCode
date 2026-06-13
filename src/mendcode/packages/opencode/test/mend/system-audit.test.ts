import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { classifyDonorReference, publicDonorReferenceAudit } from "../../src/mend/runtime/system"

describe("MendCode public donor reference audit", () => {
  test("classifies legacy compatibility separately from public donor identity", () => {
    expect(classifyDonorReference("src/config/config.ts", '$schema: "https://mendcode.ai/config.json"').allowed).toBe(true)
    expect(classifyDonorReference("src/config/config.ts", 'const value = process.env.OPENCODE_CONFIG').category).toBe("compatibility")
    expect(classifyDonorReference("src/server/auth.ts", 'import { x } from "@opencode-ai/core"').category).toBe("package-import")
    expect(classifyDonorReference("src/provider/provider.ts", '"opencode-go"').category).toBe("provider-id")
    expect(classifyDonorReference("src/cli/cmd/uninstall.ts", 'if (trimmed === "# opencode")').category).toBe("compatibility")
    expect(classifyDonorReference("src/cli/cmd/pr.ts", 'Process.text(["opencode", "import", sessionUrl], { nothrow: true })').category).toBe("donor-internal")
    expect(classifyDonorReference("src/cli/cmd/github.ts", 'uses: anomalyco/opencode/github@latest').category).toBe("donor-internal")
    expect(classifyDonorReference("src/cli/network.ts", 'default: "opencode.local"').allowed).toBe(false)
  })

  test("fails only unclassified public donor strings in audited runtime surface", async () => {
    await using dir = await tmpdir()
    const configDir = path.join(dir.path, "src", "mendcode", "packages", "opencode", "src", "config")
    const cliDir = path.join(dir.path, "src", "mendcode", "packages", "opencode", "src", "cli")
    const mcpDir = path.join(dir.path, "src", "mendcode", "packages", "opencode", "src", "cli", "cmd")
    const httpApiDir = path.join(dir.path, "src", "mendcode", "packages", "opencode", "src", "server", "routes", "instance", "httpapi")
    await mkdir(configDir, { recursive: true })
    await mkdir(cliDir, { recursive: true })
    await mkdir(mcpDir, { recursive: true })
    await mkdir(httpApiDir, { recursive: true })
    await writeFile(
      path.join(configDir, "config.ts"),
      [
        'import { Log } from "@mendcode/core"',
        'const schema = "https://mendcode.ai/config.json"',
        'const env = "OPENCODE_CONFIG"',
      ].join("\n"),
    )
    await writeFile(path.join(cliDir, "network.ts"), 'const mdns = "opencode.local"\n')
    await writeFile(path.join(mcpDir, "mcp.ts"), 'const hint = "Add servers with: mendcode mcp add"\n')
    await writeFile(path.join(httpApiDir, "public.ts"), 'const title = "MendCode HttpApi"\n')

    const audit = publicDonorReferenceAudit(dir.path)

    expect(audit.summary["package-import"]).toBe(0)
    expect(audit.summary.compatibility).toBe(1)
    expect(audit.failures).toHaveLength(1)
    expect(audit.failures[0]).toContain("src/mendcode/packages/opencode/src/cli/network.ts:1")
  })
})
