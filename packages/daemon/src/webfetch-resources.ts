import { mkdir, mkdtemp, readdir, lstat, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { sandboxCommand, type WebfetchResources, type SandboxPolicy } from "@mendcode/tools"

type Process = (argv: string[], cwd: string, signal: AbortSignal, sandbox?: SandboxPolicy) => Promise<string>
const MAX_BYTES = 50 * 1024 * 1024

/** Processes live in the daemon. Closed argv, isolated HOME, no inherited credentials or git configuration. */
const run: Process = async (argv, cwd, signal, sandbox) => {
  const wrapped = sandboxCommand({ argv, policy: sandbox })
  if (!wrapped.ok) throw new Error("sandbox refused")
  const child = Bun.spawn(wrapped.argv, { cwd, env: { PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin", HOME: cwd, TMPDIR: cwd, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" })
  const kill = () => { child.kill() }
  signal.addEventListener("abort", kill, { once: true })
  const timer = setTimeout(kill, 30_000)
  // Bound both stdout and scratch disk while the command is alive.
  const size = async (dir: string): Promise<number> => {
    let bytes = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      if (entry.isDirectory()) bytes += await size(file)
      else bytes += (await lstat(file)).size
      if (bytes > MAX_BYTES) break
    }
    return bytes
  }
  let checking = false
  const disk = setInterval(() => {
    if (checking) return
    checking = true
    void size(cwd).then((bytes) => { if (bytes > MAX_BYTES) kill() }).catch(kill).finally(() => { checking = false })
  }, 250)
  try {
    if (signal.aborted) kill()
    let text = "", total = 0
    const reader = child.stdout.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > 2 * 1024 * 1024) {
        kill()
        throw new Error("output limit")
      }
      text += decoder.decode(part.value, { stream: true })
    }
    text += decoder.decode()
    if (await child.exited !== 0 || signal.aborted || await size(cwd) > MAX_BYTES) throw new Error("process failed")
    return text
  } finally {
    clearTimeout(timer)
    clearInterval(disk)
    signal.removeEventListener("abort", kill)
    kill()
  }
}

export function createWebfetchResources(root: string, process: Process = run): WebfetchResources {
  const scratch = async () => {
    await mkdir(root, { recursive: true })
    return mkdtemp(path.join(root, "fetch-"))
  }
  return {
    async pdf(bytes, signal, sandbox) {
      if (bytes.length > 5 * 1024 * 1024 || signal.aborted) throw new Error("PDF limit")
      const dir = await scratch()
      try {
        const file = path.join(dir, "document.pdf")
        await writeFile(file, bytes, { mode: 0o600 })
        return await process(["pdftotext", "-f", "1", "-l", "100", "-layout", file, "-"], dir, signal, sandbox)
      } finally { await rm(dir, { recursive: true, force: true }) }
    },
    async clone(repository, signal, sandbox) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(repository) || repository.includes("..") || signal.aborted || sandbox && !sandbox.network) throw new Error("repository refused")
      const dir = await scratch()
      try {
        await process(["/usr/bin/git", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "core.symlinks=false", "-c", "protocol.file.allow=never", "-c", "protocol.ext.allow=never", "-c", "http.followRedirects=false", "clone", "--depth", "1", "--single-branch", "--no-tags", "--", `https://github.com/${repository}.git`, path.join(dir, "repo")], dir, signal, sandbox)
        return path.join(dir, "repo")
      } catch (error) {
        await rm(dir, { recursive: true, force: true })
        throw error
      }
    },
  }
}
