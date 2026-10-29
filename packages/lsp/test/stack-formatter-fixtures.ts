import { chmodSync } from "node:fs"
import { join } from "node:path"
import { DEFAULT_FORMATTERS } from "../src/formatter-registry"
import { STACK_FORMATTERS } from "../src/stack-formatters"
import { FORMATTER_FIXTURE } from "./formatter-fixtures"
import { put } from "./helpers"

export function stackFormatterConfig(name: string, entry: Record<string, unknown> = {}) {
  return Object.fromEntries(DEFAULT_FORMATTERS.map((spec) => [spec.name,
    spec.name === name ? entry : ["ruff", "uv"].includes(name) && ["ruff", "uv"].includes(spec.name) ? {} : { disabled: true },
  ]))
}

export function stackFormatterFixture(root: string, name: string, environment: Record<string, string> = {}) {
  const spec = STACK_FORMATTERS.find((item) => item.name === name)!
  const binary = put({ root, path: name === "pint" ? "vendor/bin/pint" : `node_modules/.bin/${spec.command[0]}`, content: `#!${process.execPath}\nimport ${JSON.stringify(FORMATTER_FIXTURE)}\n` })
  chmodSync(binary, 0o755)
  if (name === "clang-format") put({ root, path: ".clang-format", content: "BasedOnStyle: LLVM" })
  if (name === "ocamlformat") put({ root, path: ".ocamlformat", content: "version=0.26.0" })
  if (name === "ruff") put({ root, path: "pyproject.toml", content: "[tool.ruff]\nline-length = 88" })
  if (name === "pint") put({ root, path: "composer.json", content: JSON.stringify({ "require-dev": { "laravel/pint": "test" } }) })
  const config = stackFormatterConfig(name, { environment })
  put({ root, path: ".mendcode/formatter.json", content: JSON.stringify(config) })
  return { spec, binary, config, log: join(root, "runs.jsonl") }
}
