import { describe, expect, test } from "bun:test"
import { readFile, writeFile } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { mendPaths } from "../../src/mend/config/paths"
import { ensureTuiSurfaceWorkspace, readLegacyTuiSurfaceMetadata } from "../../src/mend/tui/profile-actions"

describe("legacy tui surface metadata", () => {
  test("classifies .ascii compatibility into named public surfaces", async () => {
    await using dir = await tmpdir()
    const paths = mendPaths(dir.path)
    await ensureTuiSurfaceWorkspace(dir.path)
    await writeFile(paths.tuiSurfaceHomeAscii, "HELLO\n")
    await writeFile(paths.tuiSurfaceSessionAscii, "SESSION\n")

    const workspace = await ensureTuiSurfaceWorkspace(dir.path)
    const metadata = await readLegacyTuiSurfaceMetadata(dir.path)
    const persisted = JSON.parse(await readFile(paths.tuiSurfaceMetadata, "utf8")) as any

    expect(workspace.metadata.surfaces.map((item) => item.mappedSurface)).toEqual(["home.logo", "sidebar.content"])
    expect(metadata.contractVersion).toBe("2.0.0")
    expect(metadata.surfaces[1]?.alternatives).toContain("session.prompt.visual")
    expect(path.basename(workspace.metadataPath)).toBe("legacy-surface-metadata.json")
    expect(persisted.surfaces[0]?.runtimeSlot).toBe("home_logo")
  })
})
