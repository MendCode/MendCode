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
