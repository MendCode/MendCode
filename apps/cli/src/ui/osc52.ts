/**
 * Copies text to the system clipboard through the terminal (OSC 52), so it also works over SSH and needs no
 * clipboard tool. The daemon's clipboard helper only reads images, and the client may not run programs.
 * Terminals that do not support OSC 52 ignore the sequence; there is no way to ask whether it worked.
 */

/** Base64 characters one sequence may carry; xterm and kitty accept about 100 000, tmux less, so stay under both. */
export const OSC52_MAX_BASE64 = 74_000

/** The escape sequence that sets the clipboard to `text`, or undefined when it is empty or too long for one sequence. */
export function osc52Copy(text: string, options: { tmux?: boolean } = {}): string | undefined {
  if (text.length === 0) return undefined
  const base64 = Buffer.from(text, "utf8").toString("base64")
  if (base64.length > OSC52_MAX_BASE64) return undefined
  const sequence = `\x1b]52;c;${base64}\x07`
  // tmux forwards a sequence to the outer terminal only inside its passthrough wrapper, with each ESC doubled.
  return options.tmux ? `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\` : sequence
}
