export function changesKeybindLabel(width: number) {
  if (width < 72) return "←/→ files  ↑/↓ Pg lines  l line  c note  esc"
  return "←/→ or n/p files  ↑/↓/PgUp/PgDn lines  l jump line  c comment  r reload  esc/q back"
}
