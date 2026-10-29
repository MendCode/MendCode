import type { LspServerSpec } from "./registry"

const locks = ["package-lock.json", "bun.lockb", "bun.lock", "pnpm-lock.yaml", "yarn.lock"]
const scripts = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]

export const WEB_SERVERS: readonly LspServerSpec[] = [
  { id: "deno", command: ["deno", "lsp"], extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs"], rootMarkers: ["deno.json", "deno.jsonc"], rootRequired: true, disableDownload: true },
  { id: "vue", command: ["vue-language-server", "--stdio"], extensions: [".vue"], rootMarkers: [...locks], disableDownload: true },
  { id: "eslint", command: ["vscode-eslint-language-server", "--stdio"], extensions: [...scripts, ".vue"], rootMarkers: [...locks], disableDownload: true },
  { id: "oxlint", command: ["oxlint", "--lsp"], fallbacks: [["oxc_language_server"]], extensions: [...scripts, ".vue", ".astro", ".svelte"], rootMarkers: [".oxlintrc.json", ...locks, "package.json"], disableDownload: true },
  { id: "biome", command: ["biome", "lsp-proxy", "--stdio"], extensions: [...scripts, ".json", ".jsonc", ".vue", ".astro", ".svelte", ".css", ".graphql", ".gql", ".html"], rootMarkers: ["biome.json", "biome.jsonc", ...locks], disableDownload: true },
  { id: "svelte", command: ["svelteserver", "--stdio"], extensions: [".svelte"], rootMarkers: [...locks], disableDownload: true },
  { id: "astro", command: ["astro-ls", "--stdio"], extensions: [".astro"], rootMarkers: [...locks], disableDownload: true },
  { id: "yaml-ls", command: ["yaml-language-server", "--stdio"], extensions: [".yaml", ".yml"], rootMarkers: [...locks], disableDownload: true },
  { id: "lua-ls", command: ["lua-language-server"], extensions: [".lua"], rootMarkers: [".luarc.json", ".luarc.jsonc", ".luacheckrc", ".stylua.toml", "stylua.toml", "selene.toml", "selene.yml"], disableDownload: true },
  { id: "bash", command: ["bash-language-server", "start"], extensions: [".sh", ".bash", ".zsh", ".ksh"], rootMarkers: [], disableDownload: true },
]
