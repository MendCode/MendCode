import type { Page } from "./context"

/** One page opened from another by a key: esc on the child goes back to the parent, not out to the chat. */
export type PageLink = { parent: Page; child: Page }

const MAX_LINKS = 8

/** The keys that close a page to where it was opened from. */
export const isBackKey = (key: string) => key === "\x1b" || key === "q"

/**
 * Follows one key's page change. A page opened from another page (settings → storage) is remembered; when esc then closes
 * the child to the chat, the parent opens again. Any other way to the chat (opening a session, running a command) forgets the trail.
 */
export function followPage(input: { links: readonly PageLink[]; before: Page; after: Page; key: string }): { links: PageLink[]; page: Page } {
  const { before, after, key } = input
  const links = [...input.links]
  if (after === before) return { links, page: after }
  if (after === "chat") {
    const top = links.at(-1)
    if (top && top.child === before && isBackKey(key)) {
      links.pop()
      return { links, page: top.parent }
    }
    return { links: [], page: after }
  }
  if (before === "chat") return { links: [], page: after }
  const known = links.findLastIndex((link) => link.parent === after)
  if (known >= 0) return { links: links.slice(0, known), page: after }
  links.push({ parent: before, child: after })
  return { links: links.slice(-MAX_LINKS), page: after }
}
