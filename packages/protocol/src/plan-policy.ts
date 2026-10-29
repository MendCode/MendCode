/** Explicit packet markers: an edited planning packet cannot turn acceptance into execution. */
export const isPlanningOnlyPacket = (markdown: string) => /(?:["']?(?:phase|mode)["']?\s*:\s*["']?(?:plan(?:ner)?|spec)\b|["']?(?:execute|implementation|allow_implementation)["']?\s*:\s*false\b|plan[-_ ]only|planning[-_ ]only)/i.test(markdown)
