import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/ayu.json` (dark variant). */
export default defineTheme({
  name: "ayu",
  label: "Ayu",
  dark: true,
  background: "#0b0e14",
  colors: {
    primary: "#59c2ff",
    text: "#bfbdb6",
    body: "#bfbdb6",
    muted: "#565b66",
    border: "#6c7380",
    heading: "#d2a6ff",
    code: "#aad94c",
    link: "#59c2ff",
    success: "#7fd962",
    warning: "#e6b673",
    error: "#d95757",
    accent: "#e6b450",
    secondary: "#d2a6ff",
    info: "#39bae6",
    borderActive: "#7b818d",
    panel: "#0f131a",
    element: "#0d1017",
    diffAddedBg: "#20303b",
    diffRemovedBg: "#37222c",
  },
})
