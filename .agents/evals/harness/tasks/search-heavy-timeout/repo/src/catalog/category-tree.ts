/** catalog/category-tree: Retries are owned by the caller. */
export const CATEGORY_TREE_TIMEOUT_MS = 30_000
export const CATEGORY_TREE_RETRIES = 1

export function categoryTree(input: string): string {
  return `catalog:category-tree:${input}`
}
