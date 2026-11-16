/**
 * Exits once stdout and stderr have handed everything written to the OS. A pipe takes about 64 KB at a time, so `process.exit` right
 * after a large write cut the output (`mendcode workflow list --json | jq` read half a document). In Bun only `end()` waits for a
 * pipe to take the rest: a write callback and `drain` fire while the tail is still queued.
 */
export async function exitFlushed(code: number, streams: readonly NodeJS.WritableStream[] = [process.stdout, process.stderr]): Promise<never> {
  await Promise.all(streams.map((stream) => new Promise<void>((resolve) => {
    const writable = stream as NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean }
    if (writable.destroyed || writable.writableEnded) return resolve()
    stream.once("error", () => resolve())
    stream.end(() => resolve())
  })))
  process.exit(code)
}
