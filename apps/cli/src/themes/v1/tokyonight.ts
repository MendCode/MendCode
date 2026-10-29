import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/tokyonight.json` (dark variant). */
export default defineTheme({
  name: "tokyonight",
  label: "Tokyonight",
  dark: true,
  background: "#1a1b26",
  colors: {
    primary: "#82aaff",
    text: "#c8d3f5",
    body: "#c8d3f5",
    muted: "#828bb8",
    border: "#737aa2",
    heading: "#c099ff",
    code: "#c3e88d",
    link: "#82aaff",
    success: "#c3e88d",
    warning: "#ff966c",
    error: "#ff757f",
    accent: "#ff966c",
    secondary: "#c099ff",
    info: "#82aaff",
    borderActive: "#9099b2",
    panel: "#1e2030",
    element: "#222436",
    diffAddedBg: "#20303b",
    diffRemovedBg: "#37222c",
  },
})
