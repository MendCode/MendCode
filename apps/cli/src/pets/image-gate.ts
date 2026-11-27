/** Built-in pets drawn only as pictures: half blocks turn their art into noise, so a terminal without images does not offer them. */
const IMAGE_ONLY_PETS: ReadonlySet<string> = new Set(["builtin:mendgirl"])

export const IMAGE_ONLY_REASON = "needs a terminal with images (kitty, iTerm2, sixel)"

export const petNeedsImages = (ref: string | undefined): boolean => ref !== undefined && IMAGE_ONLY_PETS.has(ref)

/** The pet that can show here: an image-only pet without a graphics terminal is MendAscii (`mend`). */
export const usablePetRef = <T extends string | undefined>(ref: T, graphics: boolean): T | "mend" => (!graphics && petNeedsImages(ref) ? "mend" : ref)
