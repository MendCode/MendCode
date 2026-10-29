import { defineTheme } from "./define"

/**
 * MendCode v1's real default, `mend-dark`: the profile tokens of `mend/profile.ts` (accent, background, foreground,
 * muted, border, backgroundPanel) with the fixed roles of `profileTheme()`. White text, gray muted, green accents.
 */
export default defineTheme({
  name: "mend",
  label: "MendCode",
  dark: true,
  background: "#08110d",
  colors: {
    primary: "#22c55e",
    text: "#ffffff",
    body: "#ffffff",
    muted: "#a3a3a3",
    border: "#636363",
    heading: "#22c55e",
    code: "#22c55e",
    link: "#38bdf8",
    success: "#22c55e",
    warning: "#f59e0b",
    error: "#ef4444",
    accent: "#22c55e",
    secondary: "#a3a3a3",
    info: "#38bdf8",
    borderActive: "#22c55e",
    panel: "#0b1f16",
    element: "#0b1f16",
    diffAddedBg: "#052e16",
    diffRemovedBg: "#450a0a",
    synComment: "#a3a3a3",
    synKeyword: "#22c55e",
    synString: "#22c55e",
    synNumber: "#f59e0b",
    synFunction: "#38bdf8",
    synType: "#a78bfa",
  },
})
