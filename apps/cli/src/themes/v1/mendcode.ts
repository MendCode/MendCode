import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/mendcode.json` (dark variant). */
export default defineTheme({
  name: "mendcode",
  label: "Mendcode",
  dark: true,
  background: "#0a0a0a",
  colors: {
    primary: "#fab283",
    text: "#eeeeee",
    body: "#eeeeee",
    muted: "#808080",
    border: "#636363",
    heading: "#9d7cd8",
    code: "#7fd88f",
    link: "#fab283",
    success: "#7fd88f",
    warning: "#f5a742",
    error: "#e06c75",
    accent: "#9d7cd8",
    secondary: "#5c9cf5",
    info: "#56b6c2",
    borderActive: "#808080",
    panel: "#141414",
    element: "#1e1e1e",
    diffAddedBg: "#033a16",
    diffRemovedBg: "#37222c",
  },
})
