import { expect, test } from "bun:test"
import { appendLiveShellOutput } from "../../../../src/cli/cmd/tui/context/shell-output"

test("live shell output appends deltas without replaying the latest line", () => {
  expect(appendLiveShellOutput("25%\n", "30%\n")).toBe("25%\n30%\n")
  expect(appendLiveShellOutput("25%\n30%\n", "30%\n")).toBe("25%\n30%\n")
  expect(appendLiveShellOutput("25%\n30%\n", "25%\n30%\n")).toBe("25%\n30%\n")
  expect(appendLiveShellOutput("25%\n30%\n", "30%\n35%\n")).toBe("25%\n30%\n35%\n")
  expect(appendLiveShellOutput("abc", "d")).toBe("abcd")
  expect(appendLiveShellOutput("25%\r30%", "\r30%")).toBe("25%\r30%")
  expect(appendLiveShellOutput("x\n", "x\n")).toBe("x\nx\n")
})
