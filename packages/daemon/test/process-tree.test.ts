import { describe, expect, test } from "bun:test"
import { descendantsOf, parentFromProcStat, processTable, signalTree } from "../src/process-tree"

const table = ["    1     0", " 4000     1", " 4001  4000", " 4002  4001", " 4003  4000", " 5000     1", "garbage", " 6000 6001", " 6001 6000"].join("\n")

describe("the process tree of a shell that stays as the parent", () => {
  test("every process below a pid is found, children before their parents, and unrelated processes are not", () => {
    expect(descendantsOf({ table, pid: 4000 })).toEqual([4002, 4001, 4003])
    expect(descendantsOf({ table, pid: 4001 })).toEqual([4002])
    expect(descendantsOf({ table, pid: 4002 })).toEqual([])
    expect(descendantsOf({ table, pid: 9999 })).toEqual([])
  })

  test("a cycle in the table ends the walk", () => {
    expect(descendantsOf({ table, pid: 6000 })).toEqual([6001])
  })

  test("a signal goes to the pid and to everything below it, descendants first, and never to a pid that cannot be a child of ours", () => {
    const sent: Array<[number, string]> = []
    const signalled = signalTree({ pid: 4000, signal: "SIGINT", table, send: (pid, name) => void sent.push([pid, name]) })
    expect(signalled).toEqual([4002, 4001, 4003, 4000])
    expect(sent).toEqual([[4002, "SIGINT"], [4001, "SIGINT"], [4003, "SIGINT"], [4000, "SIGINT"]])
    expect(signalTree({ pid: process.pid, signal: "SIGINT", table: "", send: () => { throw new Error("must not signal this process") } })).toEqual([])
    expect(signalTree({ pid: 1, signal: "SIGKILL", table, send: () => { throw new Error("must not signal init") } })).toEqual([])
  })

  test("a process that is already gone does not stop the signal reaching the others", () => {
    const signalled = signalTree({ pid: 4000, signal: "SIGTERM", table, send: (pid) => { if (pid === 4001) throw new Error("ESRCH") } })
    expect(signalled).toEqual([4002, 4003, 4000])
  })

  test("the parent is read from a /proc stat line whose command name holds spaces and parentheses", () => {
    expect(parentFromProcStat("4001 (bun) S 4000 4001 4001 0 -1 4194560")).toBe(4000)
    expect(parentFromProcStat("4002 (a (weird) name) R 4001 4002 4002 0")).toBe(4001)
    expect(parentFromProcStat("garbage")).toBeUndefined()
  })

  test("the real table of this machine lists this process under its parent", () => {
    const rows = processTable().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
    expect(rows.some(([pid, parent]) => pid === process.pid && parent === process.ppid)).toBe(true)
  })
})
