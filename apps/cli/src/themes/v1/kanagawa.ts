import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/kanagawa.json` (dark variant). */
export default defineTheme({
  name: "kanagawa",
  label: "Kanagawa",
  dark: true,
  background: "#1f1f28",
  colors: {
    primary: "#7e9cd8",
    text: "#dcd7ba",
    body: "#dcd7ba",
    muted: "#727169",
    border: "#6e6e83",
    heading: "#957fb8",
    code: "#98bb6c",
    link: "#7e9cd8",
    success: "#98bb6c",
    warning: "#d7a657",
    error: "#e82424",
    accent: "#d27e99",
    secondary: "#957fb8",
    info: "#76946a",
    borderActive: "#c38d9d",
    panel: "#2a2a37",
    element: "#363646",
    diffAddedBg: "#252e25",
    diffRemovedBg: "#362020",
  },
})
