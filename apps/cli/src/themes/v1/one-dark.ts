import { defineTheme } from "../define"

/** Ported from MendCode v1 `context/theme/one-dark.json` (dark variant). */
export default defineTheme({
  name: "one-dark",
  label: "One Dark",
  dark: true,
  background: "#282c34",
  colors: {
    primary: "#61afef",
    text: "#abb2bf",
    body: "#abb2bf",
    muted: "#5c6370",
    border: "#747980",
    heading: "#c678dd",
    code: "#98c379",
    link: "#61afef",
    success: "#98c379",
    warning: "#e5c07b",
    error: "#e06c75",
    accent: "#56b6c2",
    secondary: "#c678dd",
    info: "#d19a66",
    borderActive: "#61afef",
    panel: "#21252b",
    element: "#353b45",
    diffAddedBg: "#2c382b",
    diffRemovedBg: "#3a2d2f",
  },
})
