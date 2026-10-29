import { defineTheme } from "./define"

/** Grayscale. State is carried by bold, dim and glyphs, not hue. */
export default defineTheme({
  name: "mono",
  label: "Mono",
  dark: true,
  background: "#0c0c0c",
  colors: {
    primary: "#ffffff",
    text: "#e6e6e6",
    body: "#cfcfcf",
    muted: "#9a9a9a",
    border: "#666666",
    heading: "#ffffff",
    code: "#bdbdbd",
    link: "#e6e6e6",
    success: "#d0d0d0",
    warning: "#f2f2f2",
    error: "#ffffff",
  },
})
