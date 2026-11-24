/** What stands beside the prompt: Mend only when it is the chosen pet, the pet itself, or nothing. */
export type PromptPetKind = "mend" | "pet" | "none"

/**
 * A chosen image pet that half blocks would draw as noise (no pictures here) shows nothing: the built-in Mend replaces a
 * pet only when the user chose Mend.
 */
export function promptPetKind(input: { chosen: string; graphics: boolean; loaded: boolean; halfBlockLegible: boolean }): PromptPetKind {
  if (input.chosen === "mend") return "mend"
  if (!input.graphics && input.loaded && !input.halfBlockLegible) return "none"
  return "pet"
}
