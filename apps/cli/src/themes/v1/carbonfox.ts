import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/carbonfox.json` (dark variant). */
export default defineTheme({
  name: "carbonfox",
  label: "Carbonfox",
  dark: true,
  background: "#161616",
  colors: {
    primary: "#33b1ff",
    text: "#f2f4f8",
    body: "#f2f4f8",
    muted: "#7d848f",
    border: "#6e6e6e",
    heading: "#8cb6ff",
    code: "#25be6a",
    link: "#78a9ff",
    success: "#25be6a",
    warning: "#f1c21b",
    error: "#ee5396",
    accent: "#ff7eb6",
    secondary: "#78a9ff",
    info: "#78a9ff",
    borderActive: "#33b1ff",
    panel: "#1a1a1a",
    element: "#1e1e1e",
    diffAddedBg: "#0f2418",
    diffRemovedBg: "#2a1216",
  },
})
