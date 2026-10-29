import { commentText, MAX_COMMENTS, type ReplyComment, type ReplyUnit } from "../view/reply-comments"

/**
 * The pending comments of the session being typed in, and the modes that work on them. Plain data and small operations, no screen and
 * no timers: `app/comments.ts` drives it from keys and events, `drafts.ts` saves and restores it with the draft. One store lives for the
 * whole terminal and holds one session at a time (a session switch saves the draft, then `reset`s it).
 */

/** The prompt's text and cursor while a comment is typed in its place: they come back untouched when the comment is stored or dropped. */
export type SavedPrompt = { text: string; cursor: number; shell: boolean }

export type Composing = {
  quote: string
  itemId?: string | undefined
  /** The comment being edited; absent for a new one. */
  editId?: number | undefined
  saved: SavedPrompt
  /** A numbered decision (`1: yes, 2: no`) is being typed for these options of the answer `itemId`, instead of one comment. */
  decide?: ReadonlyArray<{ number: number; text: string }> | undefined
}

export type ReplyState = { itemId: string; units: ReplyUnit[]; index: number }

/** The offer to comment on a passage that was just copied or is selected: the quote, its message and when it lapses. */
export type Offer = { quote: string; itemId?: string | undefined; until: number; copied: boolean }

export type CommentStore = ReturnType<typeof createCommentStore>

export function createCommentStore() {
  const store = {
    /** Every comment, oldest first; the chip number is the position. */
    list: [] as ReplyComment[],
    /** Set aside with ctrl+c on an empty prompt: kept in the draft and shown as such, not sent until they are brought back. */
    parked: false,
    nextId: 1,
    composing: undefined as Composing | undefined,
    /** The list is open and this comment is selected. */
    listing: undefined as { selected: number } | undefined,
    reply: undefined as ReplyState | undefined,
    offer: undefined as Offer | undefined,
    /** The chip a click on its gutter mark pointed at. */
    focused: undefined as number | undefined,
    /** The session these belong to; `reset` forgets it. */
    owner: undefined as string | undefined,
    /** Bumped on every change, so a frame cache and the draft know the comments moved. */
    revision: 0,

    /** The comments that would be sent now. */
    active(): readonly ReplyComment[] {
      return store.parked ? [] : store.list
    },
    get count() {
      return store.list.length
    },
    /** Forgets everything (a session switch): the comments live on in the session's saved draft. */
    reset(owner?: string) {
      store.list = []
      store.parked = false
      store.nextId = 1
      store.composing = undefined
      store.listing = undefined
      store.reply = undefined
      store.offer = undefined
      store.focused = undefined
      store.owner = owner
      store.revision++
    },
    /** Takes saved comments back (a restored draft). Ids are renumbered; the modes stay closed. */
    restore(comments: readonly ReplyComment[], parked: boolean) {
      store.list = comments.slice(0, MAX_COMMENTS).map((comment, index) => ({ ...comment, id: index + 1 }))
      store.nextId = store.list.length + 1
      store.parked = parked && store.list.length > 0
      store.listing = undefined
      store.focused = undefined
      store.revision++
    },
    /** Adds a comment; undefined when `max` are held already or the words are empty. A parked set comes back with it. */
    add({ quote, text, itemId, other }: { quote: string; text: string; itemId?: string | undefined; other?: boolean }, max = MAX_COMMENTS): ReplyComment | undefined {
      const words = commentText(text)
      if (!words || !quote.trim() || store.list.length >= Math.min(max, MAX_COMMENTS)) return undefined
      const comment: ReplyComment = { id: store.nextId++, quote, text: words, ...(itemId !== undefined ? { itemId } : {}), ...(other ? { other: true as const } : {}) }
      store.list = [...store.list, comment]
      store.parked = false
      store.revision++
      return comment
    },
    /** Replaces a comment's words; false when it is gone or the words are empty. */
    edit(id: number, text: string): boolean {
      const words = commentText(text)
      const at = store.list.findIndex((comment) => comment.id === id)
      if (at < 0 || !words) return false
      store.list = store.list.map((comment, index) => (index === at ? { ...comment, text: words } : comment))
      store.revision++
      return true
    },
    remove(id: number): boolean {
      const before = store.list.length
      store.list = store.list.filter((comment) => comment.id !== id)
      if (store.list.length === 0) store.parked = false
      store.revision++
      return store.list.length < before
    },
    /** Moves a comment one place (`-1` up, `1` down) and says where it went; undefined at an end. */
    move(id: number, delta: -1 | 1): number | undefined {
      const at = store.list.findIndex((comment) => comment.id === id)
      const to = at + delta
      if (at < 0 || to < 0 || to >= store.list.length) return undefined
      const next = [...store.list]
      const [moved] = next.splice(at, 1)
      next.splice(to, 0, moved!)
      store.list = next
      store.revision++
      return to
    },
    clear(): number {
      const count = store.list.length
      store.list = []
      store.parked = false
      store.listing = undefined
      store.focused = undefined
      store.revision++
      return count
    },
    /** Sets the comments aside as a draft; false when there are none or they already are. */
    park(): boolean {
      if (store.list.length === 0 || store.parked) return false
      store.parked = true
      store.listing = undefined
      store.focused = undefined
      store.revision++
      return true
    },
    unpark(): boolean {
      if (!store.parked) return false
      store.parked = false
      store.revision++
      return true
    },
    /** A comment loses its message: a compaction removed it, and the quote is all that is left. */
    orphan(keep: (itemId: string) => boolean) {
      let changed = false
      store.list = store.list.map((comment) => {
        if (comment.itemId === undefined || keep(comment.itemId)) return comment
        changed = true
        const { itemId: _gone, ...rest } = comment
        return rest
      })
      if (changed) store.revision++
      return changed
    },
    /** Whether any mode that takes keys is open. */
    get modal() {
      return store.composing !== undefined || store.listing !== undefined || store.reply !== undefined
    },
  }
  return store
}
