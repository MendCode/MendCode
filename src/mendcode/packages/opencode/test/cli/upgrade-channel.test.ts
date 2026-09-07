import { expect, test } from "bun:test"
import yargs from "yargs"
import { UpgradeCommand } from "../../src/cli/cmd/upgrade"
import { readChannel, writeChannel } from "../../src/installation/release-channel"

test("channel subcommands persist preference without running the upgrade handler", async () => {
  let upgrades = 0
  const cli = () => yargs().exitProcess(false).command({ ...UpgradeCommand, handler: async () => { upgrades++ } })
  try {
    await cli().parseAsync(["upgrade", "channel", "set", "beta"])
    expect(await readChannel()).toBe("beta")
    await cli().parseAsync(["upgrade", "channel"])
    expect(upgrades).toBe(0)
    await cli().parseAsync(["upgrade", "0.1.43"])
    expect(upgrades).toBe(1)
    expect(await readChannel()).toBe("beta")
  } finally {
    await writeChannel("stable")
  }
})

test("upgrade and update accept an explicit read-only channel check", async () => {
  const seen: unknown[] = []
  const cli = () => yargs().exitProcess(false).command({ ...UpgradeCommand, handler: async (args) => {
    seen.push({ channel: args.channel, check: args.check })
  } })
  await cli().parseAsync(["upgrade", "--channel", "beta", "--check"])
  await cli().parseAsync(["update", "--channel", "stable", "--check"])
  expect(seen).toEqual([{ channel: "beta", check: true }, { channel: "stable", check: true }])
  expect(await readChannel()).toBe("stable")
})

test("invalid channel combinations fail before running any upgrade", async () => {
  let upgrades = 0
  for (const input of [
    ["upgrade", "--channel", "preview"],
    ["upgrade", "0.1.44", "--channel", "beta"],
    ["upgrade", "--rollback", "--channel", "stable"],
  ]) {
    const cli = yargs().exitProcess(false).showHelpOnFail(false).fail((message, error) => { throw error ?? new Error(message) })
      .command({ ...UpgradeCommand, handler: async () => { upgrades++ } })
    await expect(Promise.resolve().then(() => cli.parseAsync(input))).rejects.toThrow()
  }
  expect(upgrades).toBe(0)
  expect(await readChannel()).toBe("stable")
})
