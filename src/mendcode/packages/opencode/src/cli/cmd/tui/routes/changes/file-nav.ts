export function fileNavScrollOffset(index: number, direction: 1 | -1, height: number) {
  const rowOffset = 2 + index * 2
  if (direction < 0) return Math.max(0, rowOffset - 2)
  const visibleRows = Math.max(8, height - 10)
  return Math.max(0, rowOffset - visibleRows + 3)
}
