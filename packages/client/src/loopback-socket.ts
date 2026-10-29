/**
 * The terminal that hosts its own daemon (solo mode) talks to it without a socket: the same newline frames, handed over
 * in memory. The daemon's `attachLoopback` is the other end. Delivery is a microtask in both directions, in order, so a
 * command never runs inside the event append that caused it and the client sees the same ordering a socket gives.
 */
export type LoopbackPeer = { receive(data: Uint8Array): void; close(): void }
export type LoopbackAttach = (write: (data: Uint8Array) => number, end: () => void) => LoopbackPeer

export function connectLoopback(attach: LoopbackAttach, input: { data(data: Uint8Array): void; close(): void }) {
  let open = true
  const finish = () => {
    if (!open) return
    open = false
    queueMicrotask(() => {
      peer.close()
      input.close()
    })
  }
  const peer = attach((data) => {
    if (!open) return 0
    queueMicrotask(() => { if (open) input.data(data) })
    return data.byteLength
  }, finish)
  return Promise.resolve({
    write(data: Uint8Array) {
      if (!open) return 0
      queueMicrotask(() => { if (open) peer.receive(data) })
      return data.byteLength
    },
    end: finish,
    terminate: finish,
  })
}
