import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/solarized.json` (dark variant). */
export default defineTheme({
  name: "solarized",
  label: "Solarized",
  dark: true,
  background: "#002b36",
  colors: {
    primary: "#268bd2",
    text: "#839496",
    body: "#839496",
    muted: "#586e75",
    border: "#5e7c84",
    heading: "#268bd2",
    code: "#859900",
    link: "#2aa198",
    success: "#859900",
    warning: "#b58900",
    error: "#dc322f",
    accent: "#2aa198",
    secondary: "#6c71c4",
    info: "#cb4b16",
    borderActive: "#829298",
    panel: "#073642",
    element: "#073642",
    diffAddedBg: "#073642",
    diffRemovedBg: "#073642",
  },
})
