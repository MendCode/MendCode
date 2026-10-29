import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { sandboxBackend } from "../../../packages/tools/src/sandbox"
import { createProcessScriptHost } from "../../../packages/daemon/src/workflow-script-host"

const root = path.join(import.meta.dir, "../../..")
const enabled = process.env.MENDCODE_TEST_COMPILE === "1"
const supplied = process.env.MENDCODE_TEST_BINARY
const available = enabled && process.platform !== "win32" && sandboxBackend() !== undefined && (supplied ? existsSync(supplied) : true)
// The release workflow sets MENDCODE_REQUIRE_COMPILE: a runner without a sandbox (bubblewrap on Linux) must fail the smoke, not skip it.
if (enabled && process.platform !== "win32" && !available && process.env.MENDCODE_REQUIRE_COMPILE === "1") throw new Error("required compiled script-host smoke unavailable: no OS sandbox (Linux needs bubblewrap and unprivileged user namespaces) or no binary at MENDCODE_TEST_BINARY")

/** The compiled binary is its own script host (`__script-host`): the same sandbox profile, no Bun and no checkout on disk. */
test.skipIf(!available)("a workflow script runs in the compiled binary under the OS sandbox", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-compiled-script-")))
  try {
    const binary = supplied ? path.resolve(supplied) : path.join(dir, "mendcode")
    if (!supplied) {
      const built = Bun.spawnSync([process.execPath, "run", "build", "--outfile", binary], { cwd: root, stdout: "pipe", stderr: "pipe" })
      expect({ code: built.exitCode, stderr: built.exitCode ? built.stderr.toString() : "" }).toEqual({ code: 0, stderr: "" })
    }
    const host = createProcessScriptHost({ dir: path.join(dir, "data"), command: [binary, "__script-host"], readable: [binary] })
    const messages: Array<Record<string, unknown>> = []
    await new Promise<void>((resolve) => {
      const handle = host.start({
        workflowId: "workflow_compiled" as never, body: `const a = await agent("hi"); return [a, typeof process, typeof fetch, typeof require]`, meta: { name: "t" }, args: {}, seed: 1, now: 1, directory: dir,
        onMessage(message) {
          messages.push(message)
          if (message.t === "call") handle.send({ t: "reply", id: message.id, ok: true, value: "yo", at: 2 })
          if (message.t === "done" || message.t === "error") resolve()
        },
        onExit: () => resolve(),
      })
      setTimeout(() => { handle.kill("test timeout"); resolve() }, 15_000)
    })
    expect(messages.find((message) => message.t === "done")?.result).toEqual(["yo", "undefined", "undefined", "undefined"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}, 180_000)
