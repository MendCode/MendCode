/** How long `run MESSAGE` waits for the first byte of a stdin that is not a terminal before it goes on without it. */
export const STDIN_FIRST_BYTE_MS = 1_000

export type PipedStdin = {
  text: string
  /** True when nothing arrived within the wait and stdin was left unread. */
  skipped: boolean
}

/**
 * Stdin of `run` when it is not a terminal.
 *
 * `end`: read until the writer closes (no message was given, or the user passed `-`): stdin is the prompt, so waiting is right.
 *
 * `first-byte`: a message was given, so stdin is optional. A parent that hands down an open pipe and never writes or closes it
 * (a test runner, an agent harness, `nohup` wrappers) would otherwise block the run forever. A pipe cannot say whether its writer
 * will ever write, so the only signal is time: wait `waitMs` for the first byte or the end. Once a byte has arrived the writer is
 * real and the rest is read to the end with no limit, so a large or slow producer is never cut short; only a producer that
 * stays silent for the whole wait is skipped, and `-` is the explicit way to wait for one.
 */
export async function readPipedStdin({ stream, wait, waitMs = STDIN_FIRST_BYTE_MS }: { stream: ReadableStream<Uint8Array>; wait: "end" | "first-byte"; waitMs?: number }): Promise<PipedStdin> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  const first = reader.read()
  if (wait === "first-byte") {
    let timer: ReturnType<typeof setTimeout> | undefined
    const silent = new Promise<"silent">((resolve) => { timer = setTimeout(() => resolve("silent"), waitMs) })
    const winner = await Promise.race([first, silent])
    clearTimeout(timer)
    if (winner === "silent") {
      // The read still pending settles (or rejects) when the reader is cancelled; neither outcome matters any more.
      first.catch(() => undefined)
      void reader.cancel().catch(() => undefined)
      return { text: "", skipped: true }
    }
  }
  let text = ""
  for (let chunk = await first; !chunk.done; chunk = await reader.read()) text += decoder.decode(chunk.value, { stream: true })
  return { text: text + decoder.decode(), skipped: false }
}
