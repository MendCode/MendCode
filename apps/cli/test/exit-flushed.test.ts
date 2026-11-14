import { expect, test } from "bun:test"
import path from "node:path"

const helper = path.join(import.meta.dir, "../src/exit-flushed.ts")

test("a large output piped to a slow reader arrives whole and the exit code is kept", async () => {
  const script = `import { exitFlushed } from ${JSON.stringify(helper)}; process.stdout.write("x".repeat(300000) + "\\n"); process.stderr.write("done\\n"); await exitFlushed(3)`
  const child = Bun.spawn(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" })
  // The reader starts late, so the pipe is full when the process wants to exit.
  await Bun.sleep(300)
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  expect(out.length).toBe(300001)
  expect(err).toBe("done\n")
  expect(code).toBe(3)
})
