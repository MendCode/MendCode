export type OptionBindingKey = "q" | "l" | "r" | "p" | "," | "." | "}" | "b" | "s" | "m"
/** `macos`: read from the layout's own data with UCKeyTranslate (Option held, the key that types the letter on that layout). `unverified`: written from memory. */
export type OptionLayoutSource = "macos" | "unverified"
export type OptionLayout = { id: string; name: string; source: OptionLayoutSource; typed: Readonly<Partial<Record<OptionBindingKey, string>>> }

export const OPTION_LAYOUTS: readonly OptionLayout[] = [
  { id: "ABC", name: "ABC", source: "macos", typed: { q: "œ", l: "¬", r: "®", p: "π", ",": "≤", ".": "≥", "}": "’", b: "∫", s: "ß", m: "µ" } },
  { id: "US", name: "U.S.", source: "macos", typed: { q: "œ", l: "¬", r: "®", p: "π", ",": "≤", ".": "≥", "}": "’", b: "∫", s: "ß", m: "µ" } },
  { id: "USInternational-PC", name: "U.S. International - PC", source: "macos", typed: { q: "œ", l: "¬", r: "®", p: "π", ",": "≤", ".": "≥", "}": "’", b: "∫", s: "ß", m: "µ" } },
  { id: "USExtended", name: "ABC - Extended", source: "macos", typed: { q: "œ", r: "®", ",": "≤", ".": "≥", "}": "’", s: "ß" } },
  { id: "British", name: "British", source: "macos", typed: { q: "œ", l: "¬", r: "®", p: "π", ",": "≤", ".": "≥", "}": "’", b: "∫", s: "ß", m: "µ" } },
  { id: "Australian", name: "Australian", source: "macos", typed: { q: "œ", l: "¬", r: "®", p: "π", ",": "≤", ".": "≥", "}": "’", b: "∫", s: "ß", m: "µ" } },
  { id: "Dutch", name: "Dutch", source: "macos", typed: { q: "œ", l: "¬", r: "®", p: "π", ",": "≤", ".": "≥", "}": "’", b: "∫", s: "ß", m: "µ" } },
  { id: "Spanish-ISO", name: "Spanish", source: "macos", typed: { q: "œ", r: "®", p: "π", b: "ß", s: "∫", m: "µ" } },
  { id: "Spanish", name: "Spanish - Legacy", source: "macos", typed: { q: "œ", l: "¬", r: "®", p: "π", ",": "Ÿ", b: "∫", s: "ß", m: "µ" } },
  { id: "LatinAmerican", name: "Latin American", source: "macos", typed: { l: "λ", r: "®", p: "π", b: "∫", s: "ß", m: "µ" } },
  { id: "German", name: "German", source: "macos", typed: { r: "®", p: "π", ",": "∞", b: "∫", m: "µ" } },
  { id: "French", name: "French", source: "macos", typed: { l: "¬", r: "®", p: "π", ",": "∞", b: "ß", s: "Ò", m: "µ" } },
  { id: "French-PC", name: "French - PC", source: "macos", typed: { l: "¬", r: "®", p: "π", ",": "∞", b: "ß", s: "Ò", m: "µ" } },
  { id: "Portuguese", name: "Portuguese", source: "macos", typed: { q: "œ", r: "®", p: "π", b: "∫", s: "ß", m: "µ" } },
  { id: "Brazilian", name: "Brazilian - Legacy", source: "macos", typed: { q: "œ", l: "¬", r: "®", p: "π", ",": "≤", ".": "≥", "}": "’", b: "∫", s: "ß", m: "µ" } },
  { id: "Brazilian-ABNT2", name: "Brazilian - ABNT2", source: "macos", typed: { l: "ł", r: "®", p: "þ", ",": "≤", ".": "≥", "}": "º", b: "∫", s: "ß", m: "µ" } },
]
