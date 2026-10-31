/**
 * Replaces this process with another program (`execve`): the same pid, terminal and environment, no old process left behind.
 * Undefined where that cannot be done (Windows, a C library that is not found); the caller then keeps running as it is.
 * The returned function only comes back when the system refused.
 */
export async function selfExec(platform: NodeJS.Platform = process.platform): Promise<((file: string, args: readonly string[], env: Record<string, string | undefined>) => void) | undefined> {
  if (platform === "win32") return undefined
  try {
    const { dlopen, ptr } = await import("bun:ffi")
    const names = platform === "darwin" ? ["libSystem.B.dylib"] : ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"]
    for (const name of names) {
      let lib: { symbols: { execve(file: unknown, argv: unknown, envp: unknown): number } }
      try { lib = dlopen(name, { execve: { args: ["ptr", "ptr", "ptr"], returns: "i32" } }) as never } catch { continue }
      return (file, args, env) => {
        const strings = (list: readonly string[]) => list.map((text) => Buffer.from(`${text}\0`))
        // A null-terminated table of pointers; the buffers stay referenced until the call.
        const table = (buffers: Buffer[]) => {
          const cells = new BigUint64Array(buffers.length + 1)
          buffers.forEach((buffer, i) => { cells[i] = BigInt(ptr(buffer)) })
          return cells
        }
        const argv = strings([file, ...args])
        const envp = strings(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined).map(([key, value]) => `${key}=${value}`))
        lib.symbols.execve(ptr(argv[0]!), ptr(table(argv)), ptr(table(envp)))
      }
    }
  } catch {}
  return undefined
}
