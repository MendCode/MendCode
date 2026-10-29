import { accessSync, constants, readFileSync, statSync } from "node:fs"
import path from "node:path"
import type { PtyShell } from "@mendcode/protocol"
import { killProcessTree } from "@mendcode/tools"
import { signalTree } from "./process-tree"

export type PtyProcess = { pid: number; write(data: string): void; resize(cols: number, rows: number): void; kill(): void; /** Signals the process group of a model-owned session; fakes may omit it. */ signal?(name: NodeJS.Signals): void }
export type PtyDriver = {
  shells(): PtyShell[]
  preferred?(): string
  spawn(input: { command: string; args: string[]; cwd: string; env: Record<string, string | undefined>; cols?: number; rows?: number; data(text: string): void; exit(code: number): void }): PtyProcess
}
function executable(file: string) {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile() } catch { return false }
}

/**
 * Whether this host can open a pseudo-terminal. macOS and Linux use `Bun.Terminal`. On Windows, ConPTY is reached the
 * same way only when the runtime exposes it and the user opts in with `MENDCODE_V2_CONPTY=1`; it is unverified there,
 * so it stays off by default and the model sees `shell` (PowerShell) only.
 */
export function ptyAvailable({ platform = process.platform, env = process.env, terminal = typeof Bun.Terminal === "function" }: { platform?: string; env?: Record<string, string | undefined>; terminal?: boolean } = {}) {
  if (!terminal) return false
  return platform !== "win32" || env.MENDCODE_V2_CONPTY === "1"
}

export function nativePtyDriver(): PtyDriver {
  return {
    preferred() {
      if (process.platform === "win32") return Bun.which("pwsh") ?? Bun.which("powershell") ?? process.env.COMSPEC ?? "cmd.exe"
      const selected = process.env.SHELL && (path.isAbsolute(process.env.SHELL) ? process.env.SHELL : Bun.which(process.env.SHELL))
      if (selected && executable(selected)) return selected
      return process.platform === "darwin" ? "/bin/zsh" : Bun.which("bash") ?? "/bin/sh"
    },
    shells() {
      let files: string[]
      try { files = process.platform === "win32" ? [Bun.which("pwsh"), Bun.which("powershell"), Bun.which("bash"), process.env.COMSPEC ?? Bun.which("cmd")].filter((file): file is string => !!file) : readFileSync("/etc/shells", "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#")) }
      catch { files = ["/bin/bash", "/bin/zsh", "/bin/sh"] }
      return [...new Set(files)].filter(executable).map((file) => {
        const name = process.platform === "win32" ? path.win32.parse(file).name.toLowerCase() : path.basename(file)
        return { path: file, name, acceptable: !["fish", "nu"].includes(name) }
      })
    },
    spawn(input) {
      if (!ptyAvailable()) throw new Error("PTY runtime unavailable")
      const decoder = new TextDecoder()
      const queue: Uint8Array[] = []
      let pending = 0
      let closed = false
      const flush = (terminal: Bun.Terminal) => {
        while (!closed && queue.length) {
          const chunk = queue[0]!
          const written = terminal.write(chunk)
          if (written <= 0) return
          pending -= written
          if (written < chunk.length) { queue[0] = chunk.subarray(written); return }
          queue.shift()
        }
      }
      const terminal = new Bun.Terminal({ cols: input.cols ?? 80, rows: input.rows ?? 24, name: "xterm-256color", data: (_terminal, data) => input.data(decoder.decode(data, { stream: true })), drain: flush, exit: () => { const tail = decoder.decode(); if (tail) input.data(tail) } })
      let proc: Bun.Subprocess
      try { proc = Bun.spawn([input.command, ...input.args], { cwd: input.cwd, env: input.env, terminal }) }
      catch { terminal.close(); throw new Error("PTY spawn failed") }
      const close = () => { closed = true; queue.length = 0; pending = 0; terminal.close() }
      void proc.exited.then((code) => { close(); input.exit(code) }, () => { close(); input.exit(1) })
      return {
        pid: proc.pid,
        write(text) {
          if (closed) throw new Error("PTY exited")
          const data = new TextEncoder().encode(text)
          if (pending + data.length > 128 * 1024) throw new Error("PTY input backlog exceeded")
          queue.push(data)
          pending += data.length
          flush(terminal)
        },
        resize(cols, rows) { terminal.resize(cols, rows) },
        kill() { try { proc.kill("SIGKILL") } finally { close() } },
        signal(name) {
          // Windows has no process tree to walk here: taskkill /T does it.
          if (process.platform === "win32") return killProcessTree({ pid: proc.pid, signal: name, fallback: (fallbackName) => { try { proc.kill(fallbackName) } catch { /* already gone */ } } })
          // The process group is tried too (a launcher that made one), then the process and everything below it, which is what a shell that stays as the parent needs.
          killProcessTree({ pid: proc.pid, signal: name, fallback: () => {} })
          if (signalTree({ pid: proc.pid, signal: name }).length === 0) { try { proc.kill(name) } catch { /* already gone */ } }
        },
      }
    },
  }
}
