import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/zenburn.json` (dark variant). */
export default defineTheme({
  name: "zenburn",
  label: "Zenburn",
  dark: true,
  background: "#3f3f3f",
  colors: {
    primary: "#8cd0d3",
    text: "#dcdccc",
    body: "#dcdccc",
    muted: "#9f9f9f",
    border: "#8f8f8f",
    heading: "#f0dfaf",
    code: "#7f9f7f",
    link: "#8cd0d3",
    success: "#7f9f7f",
    warning: "#f0dfaf",
    error: "#cc9393",
    accent: "#93e0e3",
    secondary: "#dc8cc3",
    info: "#dfaf8f",
    borderActive: "#8cd0d3",
    panel: "#4f4f4f",
    element: "#5f5f5f",
    diffAddedBg: "#4f5f4f",
    diffRemovedBg: "#5f4f4f",
  },
})
