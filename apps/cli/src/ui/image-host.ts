import path from "node:path"
import type { PetImage } from "../pets/decode"
import { createFrameReader, createFramedHost, encodeFrame } from "../../../../packages/tools/src/framed-host"

/**
 * Decoding and scaling transcript pictures in a process of its own (the compiled binary with `__image-host`, or this file under
 * the same runtime from source). The terminal runs without the DFG and FTL tiers to hold less memory (apps/cli/src/launcher.ts),
 * and pixel loops are what those tiers are for: a 2880x1800 screenshot took about 250 ms to decode in the terminal and 35 ms
 * here. The host starts with the first picture to load, works on another core so keys and frames never wait for it, and leaves
 * after a few idle seconds, taking its memory with it. Frames and the process itself: packages/tools/src/framed-host.ts.
 */
export type HostRequest = { id: number; op: "decode" } | { id: number; op: "render"; width: number; height: number }
export type HostReply = { id: number; ok: true; width: number; height: number } | { id: number; ok: false; error: string }

/** Quiet time after which the host is stopped; the next picture starts it again (about 80 ms). */
export const IMAGE_HOST_IDLE_MS = 5_000

const BUNFS = /^(\/\$bunfs\/|[A-Za-z]:[\\/]~BUN[\\/])/

/** The command line of the host: the binary itself when compiled, this file under the same runtime from source. */
export function imageHostCommand(main = Bun.main, executable = process.execPath): string[] {
  return BUNFS.test(main) ? [executable, "__image-host"] : [executable, path.join(import.meta.dir, "image-host.ts")]
}

/** The host side: answers requests from stdin, one at a time, until stdin closes. */
export async function runImageHost() {
  const { decodeCardImage, renderCardImage } = await import("./image-decode")
  const reader = createFrameReader<HostRequest>()
  const out = Bun.stdout.writer()
  for await (const chunk of Bun.stdin.stream()) {
    for (const { header, payload } of reader.push(chunk)) {
      let reply: Uint8Array
      try {
        const image = header.op === "decode" ? await decodeCardImage(payload) : await renderCardImage(payload, header.width, header.height)
        reply = encodeFrame({ id: header.id, ok: true, width: image.width, height: image.height } satisfies HostReply, image.rgba)
      } catch (error) {
        reply = encodeFrame({ id: header.id, ok: false, error: error instanceof Error ? error.message : String(error) } satisfies HostReply)
      }
      out.write(reply)
      await out.flush()
      // A decode leaves tens of MB of inflated rows behind: collected now, the host stays small between pictures.
      Bun.gc(true)
    }
  }
  await out.end()
}

/** The terminal side: the image host as decode and render calls. A host that cannot run is `broken`; the caller decodes itself. */
export function createImageHost({ command = imageHostCommand(), idleMs = IMAGE_HOST_IDLE_MS }: { command?: string[]; idleMs?: number } = {}) {
  const host = createFramedHost({ command, idleMs })
  const picture = async (request: ReturnType<typeof host.request>): Promise<PetImage> => {
    const { header, payload } = await request
    return { width: Number(header.width), height: Number(header.height), rgba: payload }
  }
  return {
    /** The picture in `bytes` (PNG, JPEG, GIF or WebP) as RGBA, at most `MAX_KEPT_SIDE` on its longest side. */
    decode(bytes: Uint8Array) {
      return picture(host.request({ op: "decode" }, bytes))
    },
    /** The picture in `bytes` as `renderCardImage` draws it at `width` x `height`. */
    render(bytes: Uint8Array, width: number, height: number) {
      return picture(host.request({ op: "render", width, height }, bytes))
    },
    /** Starts the host ahead of its first picture (it takes about 80 ms to be ready); it stops again if nothing comes. */
    warm: host.warm,
    get broken() {
      return host.broken
    },
    get running() {
      return host.running
    },
    close: host.close,
  }
}

export type ImageHost = ReturnType<typeof createImageHost>

if (import.meta.main) await runImageHost()
