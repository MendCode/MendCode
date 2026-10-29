import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/vercel.json` (dark variant). */
export default defineTheme({
  name: "vercel",
  label: "Vercel",
  dark: true,
  background: "#000000",
  colors: {
    primary: "#0070f3",
    text: "#ededed",
    body: "#ededed",
    muted: "#878787",
    border: "#626262",
    heading: "#bf7af0",
    code: "#63c46d",
    link: "#52a8ff",
    success: "#46a758",
    warning: "#ffb224",
    error: "#e5484d",
    accent: "#8e4ec6",
    secondary: "#52a8ff",
    info: "#52a8ff",
    borderActive: "#7d7d7d",
    panel: "#1a1a1a",
    element: "#292929",
    diffAddedBg: "#0b1d0f",
    diffRemovedBg: "#2a1314",
  },
})
