import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/material.json` (dark variant). */
export default defineTheme({
  name: "material",
  label: "Material",
  dark: true,
  background: "#263238",
  colors: {
    primary: "#82aaff",
    text: "#eeffff",
    body: "#eeffff",
    muted: "#546e7a",
    border: "#737e84",
    heading: "#82aaff",
    code: "#c3e88d",
    link: "#89ddff",
    success: "#c3e88d",
    warning: "#ffcb6b",
    error: "#f07178",
    accent: "#89ddff",
    secondary: "#c792ea",
    info: "#ffcb6b",
    borderActive: "#82aaff",
    panel: "#1e272c",
    element: "#37474f",
    diffAddedBg: "#2e3c2b",
    diffRemovedBg: "#3c2b2b",
  },
})
