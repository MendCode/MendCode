import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/github.json` (dark variant). */
export default defineTheme({
  name: "github",
  label: "Github",
  dark: true,
  background: "#0d1117",
  colors: {
    primary: "#58a6ff",
    text: "#c9d1d9",
    body: "#c9d1d9",
    muted: "#8b949e",
    border: "#64686e",
    heading: "#58a6ff",
    code: "#ff7b72",
    link: "#58a6ff",
    success: "#3fb950",
    warning: "#e3b341",
    error: "#f85149",
    accent: "#39c5cf",
    secondary: "#bc8cff",
    info: "#d29922",
    borderActive: "#58a6ff",
    panel: "#010409",
    element: "#161b22",
    diffAddedBg: "#033a16",
    diffRemovedBg: "#67060c",
  },
})
