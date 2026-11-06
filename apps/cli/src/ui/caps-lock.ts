/**
 * Caps Lock turns every letter key into its capital: `q` arrives as `Q`, in the legacy encoding and in the kitty protocol's text field
 * alike, so a capital is not told apart from shift+letter. Pages whose shortcuts are plain letters read a capital as the same letter;
 * a page that gives shift+letter a meaning of its own keeps the raw key and is not listed here.
 */
export const foldLetter = (key: string): string => /^[A-Z]$/.test(key) ? key.toLowerCase() : key
