import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/nightowl.json` (dark variant). */
export default defineTheme({
  name: "nightowl",
  label: "Nightowl",
  dark: true,
  background: "#011627",
  colors: {
    primary: "#82aaff",
    text: "#d6deeb",
    body: "#d6deeb",
    muted: "#5f7e97",
    border: "#5f7e97",
    heading: "#82aaff",
    code: "#c5e478",
    link: "#7fdbca",
    success: "#c5e478",
    warning: "#ecc48d",
    error: "#ef5350",
    accent: "#c792ea",
    secondary: "#7fdbca",
    info: "#82aaff",
    borderActive: "#82aaff",
    panel: "#0b253a",
    element: "#0b253a",
    diffAddedBg: "#0a2e1a",
    diffRemovedBg: "#2d1b1b",
  },
})
