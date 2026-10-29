import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/aura.json` (dark variant). */
export default defineTheme({
  name: "aura",
  label: "Aura",
  dark: true,
  background: "#0f0f0f",
  colors: {
    primary: "#a277ff",
    text: "#edecee",
    body: "#edecee",
    muted: "#6d6d6d",
    border: "#626262",
    heading: "#a277ff",
    code: "#61ffca",
    link: "#f694ff",
    success: "#61ffca",
    warning: "#ffca85",
    error: "#ff6767",
    accent: "#a277ff",
    secondary: "#f694ff",
    info: "#a277ff",
    borderActive: "#7c7c7c",
    panel: "#15141b",
    element: "#15141b",
    diffAddedBg: "#354933",
    diffRemovedBg: "#3f191a",
  },
})
