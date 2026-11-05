import { expect, test } from "bun:test"
import path from "node:path"
import { z } from "zod"

const root = path.resolve(import.meta.dir, "../../..")

test("the shipped CLI graph includes only the English Zod locale", () => {
  // Build, never execute the CLI. Checking every chunk is stronger than checking only
  // static imports: the solo prompt also loads the daemon through a dynamic import.
  // A fresh bundler avoids Bun 1.3.13's resolution cache in the test process.
  const build = Bun.spawnSync([process.execPath, "-e", `
    const build = await Bun.build({
      entrypoints: ["apps/cli/src/entry.ts"], target: "bun",
      splitting: true, minify: true, metafile: true, write: false,
    });
    if (!build.success) throw new AggregateError(build.logs, "CLI build failed");
    console.log(JSON.stringify(Object.keys(build.metafile.inputs)));
  `], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(build.stderr.toString()).toBe("")
  expect(build.exitCode).toBe(0)
  const inputs = JSON.parse(build.stdout.toString()) as string[]
  const locales = inputs
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => file.includes("/zod/v4/locales/"))
    .map((file) => file.slice(file.lastIndexOf("/") + 1))
  expect(locales).toEqual(["en.js"])
})

test("Zod still uses its default English validation messages", () => {
  const parsed = z.string().safeParse(42)
  expect(parsed.success).toBe(false)
  expect(parsed.error?.issues[0]?.message).toBe("Invalid input: expected string, received number")
  expect(z.string().parse("unchanged")).toBe("unchanged")
})

test("Bun and pnpm use the same versioned Zod patch", async () => {
  const manifest = await Bun.file(path.join(root, "package.json")).json()
  const key = "zod@4.6.6"
  expect(manifest.patchedDependencies?.[key]).toBe("patches/zod@4.6.6.patch")
  expect(manifest.pnpm?.patchedDependencies).toEqual(manifest.patchedDependencies)
  const workspace = Bun.YAML.parse(await Bun.file(path.join(root, "pnpm-workspace.yaml")).text()) as { patchedDependencies: Record<string, string> }
  expect(workspace.patchedDependencies).toEqual(manifest.patchedDependencies)
  expect(await Bun.file(path.join(root, manifest.patchedDependencies[key])).exists()).toBe(true)
})
