import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { FormatterSpec } from "./formatter-registry"

export const STACK_FORMATTERS: FormatterSpec[] = [
  { name: "gofmt", command: ["gofmt", "-w", "$FILE"], extensions: [".go"] },
  { name: "mix", command: ["mix", "format", "$FILE"], extensions: [".ex", ".exs", ".eex", ".heex", ".leex", ".neex", ".sface"] },
  { name: "zig", command: ["zig", "fmt", "$FILE"], extensions: [".zig", ".zon"] },
  { name: "clang-format", command: ["clang-format", "-i", "$FILE"], extensions: [".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hh", ".hpp", ".hxx", ".h++", ".ino", ".C", ".H"], project: "clang" },
  { name: "ktlint", command: ["ktlint", "-F", "$FILE"], extensions: [".kt", ".kts"] },
  { name: "ruff", command: ["ruff", "format", "$FILE"], extensions: [".py", ".pyi"], project: "ruff" },
  { name: "air", command: ["air", "format", "$FILE"], extensions: [".R"], probe: "air" },
  { name: "uv", command: ["uv", "format", "--", "$FILE"], extensions: [".py", ".pyi"], probe: "uv" },
  { name: "rubocop", command: ["rubocop", "--autocorrect", "$FILE"], extensions: [".rb", ".rake", ".gemspec", ".ru"] },
  { name: "standardrb", command: ["standardrb", "--fix", "$FILE"], extensions: [".rb", ".rake", ".gemspec", ".ru"] },
  { name: "htmlbeautifier", command: ["htmlbeautifier", "$FILE"], extensions: [".erb", ".html.erb"] },
  { name: "dart", command: ["dart", "format", "$FILE"], extensions: [".dart"] },
  { name: "ocamlformat", command: ["ocamlformat", "-i", "$FILE"], extensions: [".ml", ".mli"], project: "ocaml" },
  { name: "terraform", command: ["terraform", "fmt", "$FILE"], extensions: [".tf", ".tfvars"] },
  { name: "latexindent", command: ["latexindent", "-w", "-s", "$FILE"], extensions: [".tex"] },
  { name: "gleam", command: ["gleam", "format", "$FILE"], extensions: [".gleam"] },
  { name: "shfmt", command: ["shfmt", "-w", "$FILE"], extensions: [".sh", ".bash"] },
  { name: "nixfmt", command: ["nixfmt", "$FILE"], extensions: [".nix"] },
  { name: "rustfmt", command: ["rustfmt", "$FILE"], extensions: [".rs"] },
  { name: "pint", command: ["./vendor/bin/pint", "$FILE"], extensions: [".php"], project: "pint" },
  { name: "ormolu", command: ["ormolu", "-i", "$FILE"], extensions: [".hs"] },
  { name: "cljfmt", command: ["cljfmt", "fix", "--quiet", "$FILE"], extensions: [".clj", ".cljs", ".cljc", ".edn"] },
  { name: "dfmt", command: ["dfmt", "-i", "$FILE"], extensions: [".d"] },
]

async function nearestText(directories: string[], file: string) {
  for (const directory of directories) {
    const text = await readFile(join(directory, file), "utf8").catch(() => undefined)
    if (text !== undefined) return text
  }
}

export async function stackFormatterConfigured(spec: FormatterSpec, directories: string[]): Promise<boolean> {
  if (spec.project === "clang") return await nearestText(directories, ".clang-format") !== undefined
  if (spec.project === "ocaml") return await nearestText(directories, ".ocamlformat") !== undefined
  if (spec.project === "ruff") {
    if (await nearestText(directories, "ruff.toml") !== undefined || await nearestText(directories, ".ruff.toml") !== undefined) return true
    for (const file of ["pyproject.toml", "requirements.txt", "Pipfile"]) {
      if ((await nearestText(directories, file))?.includes("ruff")) return true
    }
    return false
  }
  if (spec.project === "pint") {
    for (const directory of directories) {
      const pkg = await readFile(join(directory, "composer.json"), "utf8").then((text) => JSON.parse(text)).catch(() => undefined)
      if (pkg?.require?.["laravel/pint"] || pkg?.["require-dev"]?.["laravel/pint"]) return true
    }
    return false
  }
  return true
}
