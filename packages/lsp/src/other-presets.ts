import type { LspServerSpec } from "./registry"

const gradleRoots = [["settings.gradle", "settings.gradle.kts"], ["gradlew", "gradlew.bat"], ["pom.xml", "build.gradle", "build.gradle.kts", ".project", ".classpath"]]

/** Installed-only presets from v1; provisioning requires a separately chosen stack. */
export const OTHER_SERVERS: readonly LspServerSpec[] = [
  { id: "ruby-lsp", command: ["rubocop", "--lsp"], extensions: [".rb", ".rake", ".gemspec", ".ru"], rootMarkers: ["Gemfile"], disableDownload: true },
  { id: "ty", command: ["ty", "server"], extensions: [".py", ".pyi"], rootMarkers: ["pyproject.toml", "ty.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile", "pyrightconfig.json"], enabled: false, disableDownload: true },
  { id: "elixir-ls", command: ["elixir-ls"], extensions: [".ex", ".exs"], rootMarkers: ["mix.exs", "mix.lock"], disableDownload: true },
  { id: "zls", command: ["zls"], extensions: [".zig", ".zon"], rootMarkers: ["build.zig"], disableDownload: true },
  { id: "csharp", command: ["roslyn-language-server", "--stdio", "--autoLoadProjects"], extensions: [".cs", ".csx"], rootMarkers: ["*.slnx", "*.sln", "*.csproj", "global.json"], disableDownload: true },
  { id: "razor", command: ["roslyn-language-server", "--stdio", "--autoLoadProjects"], extensions: [".razor", ".cshtml"], rootMarkers: ["*.slnx", "*.sln", "*.csproj", "global.json"], disableDownload: true },
  { id: "fsharp", command: ["fsautocomplete"], extensions: [".fs", ".fsi", ".fsx", ".fsscript"], rootMarkers: ["*.slnx", "*.sln", "*.fsproj", "global.json"], disableDownload: true },
  { id: "sourcekit-lsp", command: ["sourcekit-lsp"], extensions: [".swift", ".objc", ".objcpp"], rootMarkers: ["Package.swift", "*.xcodeproj", "*.xcworkspace"], disableDownload: true },
  { id: "clangd", command: ["clangd", "--background-index", "--clang-tidy"], extensions: [".c", ".cpp", ".cc", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++"], rootMarkers: ["compile_commands.json", "compile_flags.txt", ".clangd"], disableDownload: true },
  { id: "jdtls", command: ["jdtls"], extensions: [".java"], rootMarkers: gradleRoots.flat(), rootGroups: gradleRoots, disableDownload: true },
  { id: "kotlin-ls", command: ["kotlin-lsp", "--stdio"], fallbacks: [["kotlin-lsp.sh", "--stdio"], ["kotlin-lsp.cmd", "--stdio"]], extensions: [".kt", ".kts"], rootMarkers: gradleRoots.flat(), rootGroups: gradleRoots, disableDownload: true },
  { id: "php intelephense", command: ["intelephense", "--stdio"], extensions: [".php"], rootMarkers: ["composer.json", "composer.lock", ".php-version"], initialization: { telemetry: { enabled: false } }, disableDownload: true },
  { id: "prisma", command: ["prisma", "language-server"], extensions: [".prisma"], rootMarkers: ["schema.prisma", "prisma/schema.prisma", "prisma"], rootExcludes: ["package.json"], disableDownload: true },
  { id: "dart", command: ["dart", "language-server", "--lsp"], extensions: [".dart"], rootMarkers: ["pubspec.yaml", "analysis_options.yaml"], disableDownload: true },
  { id: "ocaml-lsp", command: ["ocamllsp"], extensions: [".ml", ".mli"], rootMarkers: ["dune-project", "dune-workspace", ".merlin", "opam"], disableDownload: true },
  { id: "terraform", command: ["terraform-ls", "serve"], extensions: [".tf", ".tfvars"], rootMarkers: [".terraform.lock.hcl", "terraform.tfstate", "*.tf"], initialization: { experimentalFeatures: { prefillRequiredFields: true, validateOnSave: true } }, disableDownload: true },
  { id: "texlab", command: ["texlab"], extensions: [".tex", ".bib"], rootMarkers: [".latexmkrc", "latexmkrc", ".texlabroot", "texlabroot"], disableDownload: true },
  { id: "dockerfile", command: ["docker-langserver", "--stdio"], extensions: [".dockerfile"], filenames: ["Dockerfile"], rootMarkers: [], disableDownload: true },
  { id: "gleam", command: ["gleam", "lsp"], extensions: [".gleam"], rootMarkers: ["gleam.toml"], disableDownload: true },
  { id: "clojure-lsp", command: ["clojure-lsp", "listen"], extensions: [".clj", ".cljs", ".cljc", ".edn"], rootMarkers: ["deps.edn", "project.clj", "shadow-cljs.edn", "bb.edn", "build.boot"], disableDownload: true },
  { id: "nixd", command: ["nixd"], extensions: [".nix"], rootMarkers: ["flake.nix"], rootFallback: "git", disableDownload: true },
  { id: "tinymist", command: ["tinymist"], extensions: [".typ", ".typc"], rootMarkers: ["typst.toml"], disableDownload: true },
  { id: "haskell-language-server", command: ["haskell-language-server-wrapper", "--lsp"], extensions: [".hs", ".lhs"], rootMarkers: ["stack.yaml", "cabal.project", "hie.yaml", "*.cabal"], disableDownload: true },
  { id: "julials", command: ["julia", "--startup-file=no", "--history-file=no", "-e", "using LanguageServer; runserver()"], extensions: [".jl"], rootMarkers: ["Project.toml", "Manifest.toml", "*.jl"], disableDownload: true },
]

export const OTHER_LANGUAGE_IDS: Record<string, string> = {
  ".rb": "ruby", ".rake": "ruby", ".gemspec": "ruby", ".ru": "ruby",
  ".ex": "elixir", ".exs": "elixir", ".zig": "zig", ".zon": "zig",
  ".cs": "csharp", ".csx": "csharp", ".razor": "razor", ".cshtml": "razor",
  ".fs": "fsharp", ".fsi": "fsharp", ".fsx": "fsharp", ".fsscript": "fsharp",
  ".swift": "swift", ".objc": "objective-c", ".objcpp": "objective-cpp",
  ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp", ".c++": "cpp", ".hpp": "cpp", ".hh": "cpp", ".hxx": "cpp", ".h++": "cpp",
  ".java": "java", ".kt": "kotlin", ".kts": "kotlin", ".php": "php", ".prisma": "prisma", ".dart": "dart",
  ".ml": "ocaml", ".mli": "ocaml", ".tf": "terraform", ".tfvars": "terraform-vars", ".tex": "latex", ".bib": "bibtex",
  ".dockerfile": "dockerfile", ".gleam": "gleam", ".clj": "clojure", ".cljs": "clojure", ".cljc": "clojure", ".edn": "clojure",
  ".nix": "nix", ".typ": "typst", ".typc": "typst", ".hs": "haskell", ".lhs": "haskell", ".jl": "julia",
}
