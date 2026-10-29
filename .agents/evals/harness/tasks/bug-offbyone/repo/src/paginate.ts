export type Page<T> = {
  items: T[]
  page: number
  pageCount: number
  hasNext: boolean
  hasPrevious: boolean
}

/** Pages are 1-based. A page past the end has no items. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new RangeError("pageSize must be a positive integer")
  if (!Number.isInteger(page) || page < 1) throw new RangeError("page must be a positive integer")
  const pageCount = Math.max(1, Math.ceil(items.length / pageSize))
  const start = (page - 1) * pageSize
  const end = start + pageSize - 1
  return {
    items: items.slice(start, end),
    page,
    pageCount,
    hasNext: page < pageCount,
    hasPrevious: page > 1,
  }
}

/** Human label such as "Showing 5-8 of 10". */
export function describePage(total: number, page: number, pageSize: number): string {
  if (total === 0) return "Showing 0 of 0"
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return `Showing ${from}-${to} of ${total}`
}
