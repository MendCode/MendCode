import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/cobalt2.json` (dark variant). */
export default defineTheme({
  name: "cobalt2",
  label: "Cobalt2",
  dark: true,
  background: "#193549",
  colors: {
    primary: "#0088ff",
    text: "#ffffff",
    body: "#ffffff",
    muted: "#adb7c9",
    border: "#6d8799",
    heading: "#ffc600",
    code: "#9eff80",
    link: "#0088ff",
    success: "#9eff80",
    warning: "#ffc600",
    error: "#ff0088",
    accent: "#2affdf",
    secondary: "#9a5feb",
    info: "#ff9d00",
    borderActive: "#33a0ff",
    panel: "#122738",
    element: "#1f4662",
    diffAddedBg: "#1a3a2a",
    diffRemovedBg: "#3a1a2a",
  },
})
