/** "Hello,  World!" -> "hello-world": lowercase, every run of non-alphanumerics becomes one dash, no leading or trailing dash. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "-")
}

/** "the quick  brown fox" -> "The Quick Brown Fox": the first letter of each word is upper-cased, the rest lower-cased, spacing kept. */
export function capitalizeWords(text: string): string {
  return text.replace(/\b\w/g, (letter) => letter.toUpperCase())
}
