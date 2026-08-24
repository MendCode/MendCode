export function changesKeybindLabel(width: number) {
  if (width < 72) return "←/→ files  ↑/↓ lines  w wrap  i sidebar  l line  c note  esc"
  return "←/→ or n/p files  ↑/↓/PgUp/PgDn lines  w wrap/scroll  i sidebar  l jump line  c comment  r reload  esc/q back"
}
