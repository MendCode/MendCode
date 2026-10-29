import type { PtyDriver } from "../src/pty-native"

export function fakePtyDriver() {
  const processes: Array<Parameters<PtyDriver["spawn"]>[0] & { writes: string[]; sizes: Array<[number, number]>; kills: number }> = []
  const driver: PtyDriver = {
    shells: () => [{ path: "/fake/sh", name: "sh", acceptable: true }, { path: "/fake/fish", name: "fish", acceptable: false }],
    spawn(input) {
      const process = { ...input, writes: [] as string[], sizes: [] as Array<[number, number]>, kills: 0 }
      processes.push(process)
      return { pid: 100 + processes.length, write: (data) => { process.writes.push(data) }, resize: (cols, rows) => { process.sizes.push([cols, rows]) }, kill: () => { process.kills++ } }
    },
  }
  return { driver, processes }
}
