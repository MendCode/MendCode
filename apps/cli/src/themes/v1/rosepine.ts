import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/rosepine.json` (dark variant). */
export default defineTheme({
  name: "rosepine",
  label: "Rosepine",
  dark: true,
  background: "#191724",
  colors: {
    primary: "#9ccfd8",
    text: "#e0def4",
    body: "#e0def4",
    muted: "#6e6a86",
    border: "#706e7d",
    heading: "#c4a7e7",
    code: "#31748f",
    link: "#9ccfd8",
    success: "#31748f",
    warning: "#f6c177",
    error: "#eb6f92",
    accent: "#ebbcba",
    secondary: "#c4a7e7",
    info: "#9ccfd8",
    borderActive: "#9ccfd8",
    panel: "#1f1d2e",
    element: "#26233a",
    diffAddedBg: "#1f2d3a",
    diffRemovedBg: "#3a1f2d",
  },
})
