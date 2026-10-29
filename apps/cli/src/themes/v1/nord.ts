import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/nord.json` (dark variant). */
export default defineTheme({
  name: "nord",
  label: "Nord",
  dark: true,
  background: "#2e3440",
  colors: {
    primary: "#88c0d0",
    text: "#eceff4",
    body: "#d8dee9",
    muted: "#8b95a7",
    border: "#7b828e",
    heading: "#88c0d0",
    code: "#a3be8c",
    link: "#81a1c1",
    success: "#a3be8c",
    warning: "#d08770",
    error: "#bf616a",
    accent: "#8fbcbb",
    secondary: "#81a1c1",
    info: "#88c0d0",
    borderActive: "#9da2ad",
    panel: "#3b4252",
    element: "#434c5e",
    diffAddedBg: "#3b4252",
    diffRemovedBg: "#3b4252",
  },
})
