import yargs from "yargs"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { Installation } from "./installation"
import { hideBin } from "yargs/helpers"
import { Log } from "./node"

Log.init({
  print: false,
})

const cli = yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("mendcode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", Installation.displayVersion())
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .command(TuiThreadCommand)
  .parse()
