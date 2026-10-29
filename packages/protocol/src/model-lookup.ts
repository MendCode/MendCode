/**
 * Looking a model up in a catalog by the id a person may give. Zod-free: thin clients import it through
 * "@mendcode/protocol/wire". Only the fields the lookup reads are required, so `ModelInfo` and lighter rows both fit.
 */
type Row = { id: string; name: string; engine?: string | undefined; resolved?: string | undefined }

/** After a family alias: a version (`-5`, `-5-5`) and optionally a release date (`-20251001`). */
const PINNED_VERSION = /^-(\d{1,2})(?:-(\d{1,2}))?(?:-(\d{8}))?$/

/**
 * The catalog entry for `id`: the entry with that id, else a pinned version of a Claude Code family alias. The catalog
 * lists `claude-haiku` (Claude Code's own alias, always its newest of the family); `claude-haiku-5-5` or
 * `claude-haiku-4-5-20251001` is that family pinned to one model, which `claude --model` takes as it is. The pinned
 * entry is the alias's with the full id and a name that says the version. No table of versions: whether the model
 * exists is Claude Code's answer on the first turn. Anything else (`claude-nonsense`, `claude-haiku-fast`) is unknown.
 */
export function findModel<T extends Row>(models: readonly T[], id: string): T | undefined {
  const exact = models.find((model) => model.id === id)
  if (exact) return exact
  for (const alias of models) {
    if (alias.engine !== "claude" || !/^claude-[a-z]+$/.test(alias.id) || !id.startsWith(alias.id)) continue
    const version = PINNED_VERSION.exec(id.slice(alias.id.length))
    if (!version) continue
    const [head = alias.name, ...tags] = alias.name.split(" · ")
    const shown = `${head} ${version[1]}${version[2] ? `.${version[2]}` : ""}${version[3] ? ` (${version[3]})` : ""}`
    const { resolved: _resolved, ...rest } = alias
    return { ...rest, id, name: [shown, ...tags].join(" · ") } as T
  }
  return undefined
}

/**
 * Whether Claude Code's fast mode exists for a model: Opus 5.5, Opus 5 and Opus 4.8 (code.claude.com/docs/en/fast-mode), and the
 * `opus` alias, which is the latest Opus. A pinned date (`-20260101`) keeps the version it pins.
 */
export function claudeFastModel(model: string | undefined): boolean {
  return /^(claude-)?opus(-5|-5-5|-4-8)?(-\d{8})?$/.test(model ?? "")
}
