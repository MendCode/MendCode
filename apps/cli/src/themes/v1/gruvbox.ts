import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/gruvbox.json` (dark variant). */
export default defineTheme({
  name: "gruvbox",
  label: "Gruvbox",
  dark: true,
  background: "#282828",
  colors: {
    primary: "#83a598",
    text: "#ebdbb2",
    body: "#ebdbb2",
    muted: "#928374",
    border: "#7d746e",
    heading: "#83a598",
    code: "#fabd2f",
    link: "#8ec07c",
    success: "#b8bb26",
    warning: "#fe8019",
    error: "#fb4934",
    accent: "#8ec07c",
    secondary: "#d3869b",
    info: "#fabd2f",
    borderActive: "#ebdbb2",
    panel: "#3c3836",
    element: "#504945",
    diffAddedBg: "#32302f",
    diffRemovedBg: "#322929",
  },
})
