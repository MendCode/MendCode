export const EDIT_ACTIONS = [
  "newline", "move-left", "move-right", "move-up", "move-down", "select-left", "select-right", "select-up", "select-down",
  "line-home", "line-end", "select-line-home", "select-line-end", "visual-line-home", "visual-line-end", "select-visual-line-home", "select-visual-line-end",
  "buffer-home", "buffer-end", "select-buffer-home", "select-buffer-end", "delete-line", "delete-to-line-end", "delete-to-line-start",
  "backspace", "delete", "word-forward", "word-backward", "select-word-forward", "select-word-backward", "delete-word-forward", "delete-word-backward",
  "yank", "yank-pop", "jump-forward", "jump-backward",
] as const
export type EditAction = (typeof EDIT_ACTIONS)[number]

/** Terminal encodings of v1's textarea defaults; also used by the configurable app keymap. */
export const EDIT_KEYS: Record<string, EditAction> = {
  "\x1b\r": "newline", "\n": "newline", "\x1b[13;2u": "newline", "\x1b[13;5u": "newline", "\x1b[27;2;13~": "newline", "\x1b[27;5;13~": "newline",
  "\x1b[D": "move-left", "\x1bOD": "move-left", "\x02": "move-left", "\x1b[C": "move-right", "\x1bOC": "move-right", "\x06": "move-right",
  "\x1b[A": "move-up", "\x1bOA": "move-up", "\x1b[B": "move-down", "\x1bOB": "move-down",
  "\x1b[1;2D": "select-left", "\x1b[1;2C": "select-right", "\x1b[1;2A": "select-up", "\x1b[1;2B": "select-down",
  "\x01": "line-home", "\x05": "line-end", "\x1b[97;6u": "select-line-home", "\x1b[101;6u": "select-line-end",
  "\x1ba": "visual-line-home", "\x1be": "visual-line-end", "\x1bA": "select-visual-line-home", "\x1bE": "select-visual-line-end",
  "\x1b[97;3u": "visual-line-home", "\x1b[101;3u": "visual-line-end", "\x1b[97;4u": "select-visual-line-home", "\x1b[101;4u": "select-visual-line-end", "\x1b[13;3u": "newline",
  "\x1b[H": "buffer-home", "\x1bOH": "buffer-home", "\x1b[1~": "buffer-home", "\x1b[F": "buffer-end", "\x1bOF": "buffer-end", "\x1b[4~": "buffer-end",
  "\x1b[1;2H": "select-buffer-home", "\x1b[1;2F": "select-buffer-end", "\x1b[1;2~": "select-buffer-home", "\x1b[4;2~": "select-buffer-end",
  "\x1b[100;6u": "delete-line", "\x0b": "delete-to-line-end", "\x15": "delete-to-line-start",
  "\x7f": "backspace", "\b": "backspace", "\x1b[3~": "delete", "\x04": "delete", "\x1b[3;2~": "delete",
  "\x1bf": "word-forward", "\x1b[1;3C": "word-forward", "\x1b[1;5C": "word-forward", "\x1bb": "word-backward", "\x1b[1;3D": "word-backward", "\x1b[1;5D": "word-backward",
  "\x1bF": "select-word-forward", "\x1b[1;4C": "select-word-forward", "\x1bB": "select-word-backward", "\x1b[1;4D": "select-word-backward",
  "\x1b[102;3u": "word-forward", "\x1b[98;3u": "word-backward", "\x1b[102;4u": "select-word-forward", "\x1b[98;4u": "select-word-backward", "\x1b[100;3u": "delete-word-forward",
  "\x1bd": "delete-word-forward", "\x1b[3;3~": "delete-word-forward", "\x1b[3;5~": "delete-word-forward", "\x17": "delete-word-backward",
  // alt+backspace (option on macOS): ESC DEL from a terminal that sends option as meta, ESC BS from some, CSI u from kitty-protocol ones; ctrl+backspace too.
  "\x1b\x7f": "delete-word-backward", "\x1b\b": "delete-word-backward", "\x1b[127;3u": "delete-word-backward", "\x1b[127;5u": "delete-word-backward",
  // Kill ring (ctrl+y stays redo): alt+y yanks the last kill, alt+shift+y swaps it for the one before; alt+j / alt+shift+j wait for a character and jump to it.
  "\x1by": "yank", "\x1b[121;3u": "yank", "\x1bY": "yank-pop", "\x1b[121;4u": "yank-pop",
  "\x1bj": "jump-forward", "\x1b[106;3u": "jump-forward", "\x1bJ": "jump-backward", "\x1b[106;4u": "jump-backward",
}
