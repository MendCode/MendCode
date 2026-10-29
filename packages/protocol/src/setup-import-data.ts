/**
 * `/import setup` selection key, shared by the daemon (which matches it) and the terminal (which builds it). Data and
 * pure functions only, no imports, so the thin client can use it without loading zod.
 *
 * One importable item is named by its kind, the tool it comes from, its scope and its name, so the same server name
 * from Claude Code and from Codex stays two different choices.
 */
export type SetupImportKeyParts = { kind: string; tool: string; scope: string; name: string }

export const setupImportKey = ({ kind, tool, scope, name }: SetupImportKeyParts): string => `${kind}:${tool}:${scope}:${name}`
