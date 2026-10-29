/** Quotes become a draft; the user adds their comment and sends it explicitly. */
export function quoteWithComment(text: string, comment = "") {
  return `${text.slice(0, 16000).split("\n").map((line) => `> ${line}`).join("\n")}\n\n${comment}`
}
