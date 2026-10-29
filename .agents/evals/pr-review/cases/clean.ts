import type { PrCase } from "./types"

/** Six PRs with no defect: correct changes of the same shapes as the seeded ones. Every finding on them is a false positive. */
export const CLEAN: PrCase[] = [
  {
    id: "clean-page",
    title: "Paginate the order list",
    base: { "src/orders.ts": "export type Order = { id: string; total: number }\n" },
    head: { "src/orders.ts": "export type Order = { id: string; total: number }\n\n/** Page `page` (from 0) of `size` orders. */\nexport function pageOf(orders: Order[], page: number, size: number): Order[] {\n  if (!Number.isInteger(page) || page < 0 || !Number.isInteger(size) || size < 1) throw new RangeError(\"page must be >= 0 and size >= 1\")\n  const start = page * size\n  return orders.slice(start, start + size)\n}\n" },
    defects: [],
  },
  {
    id: "clean-rename",
    title: "Save the user before answering",
    base: { "src/users.ts": "export type User = { id: string; name: string }\nexport interface Store { save(user: User): Promise<void> }\n" },
    head: { "src/users.ts": "export type User = { id: string; name: string }\nexport interface Store { save(user: User): Promise<void> }\n\nexport async function rename(store: Store, user: User, name: string): Promise<User> {\n  const next = { ...user, name: name.trim() }\n  await store.save(next)\n  return next\n}\n" },
    defects: [],
  },
  {
    id: "clean-search",
    title: "Search customers by name",
    base: { "src/db.ts": "export interface Db { query(sql: string, params?: unknown[]): Promise<unknown[]> }\n" },
    head: { "src/db.ts": "export interface Db { query(sql: string, params?: unknown[]): Promise<unknown[]> }\n\nconst escapeLike = (text: string) => text.replace(/[\\\\%_]/g, (char) => `\\\\${char}`)\n\nexport async function searchCustomers(db: Db, name: string) {\n  return db.query(\"SELECT * FROM customers WHERE name LIKE $1 ESCAPE '\\\\'\", [`%${escapeLike(name)}%`])\n}\n" },
    defects: [],
  },
  {
    id: "clean-dedupe",
    title: "Drop duplicate events before upload",
    base: { "src/events.ts": "export type Event = { id: string; at: number }\n" },
    head: { "src/events.ts": "export type Event = { id: string; at: number }\n\n/** The first event of each id, in order. */\nexport function dedupe(events: Event[]): Event[] {\n  const seen = new Set<string>()\n  return events.filter((event) => (seen.has(event.id) ? false : (seen.add(event.id), true)))\n}\n" },
    defects: [],
  },
  {
    id: "clean-split",
    title: "Split the bill",
    base: { "src/bill.ts": "/** Amounts are integer cents everywhere in this module. */\nexport type Cents = number\n" },
    head: { "src/bill.ts": "/** Amounts are integer cents everywhere in this module. */\nexport type Cents = number\n\n/** Shares that add up to `total` exactly; the first `total % people` shares get one cent more. */\nexport function split(total: Cents, people: number): Cents[] {\n  if (!Number.isInteger(total) || !Number.isInteger(people) || people < 1) throw new RangeError(\"integer total and at least one person\")\n  const base = Math.floor(total / people)\n  return Array.from({ length: people }, (_, index) => base + (index < total % people ? 1 : 0))\n}\n" },
    defects: [],
  },
  {
    id: "clean-docs-rename",
    title: "Rename a local variable and update the comment",
    base: { "src/sum.ts": "/** Adds the numbers. */\nexport function sum(xs: number[]): number {\n  let t = 0\n  for (const x of xs) t += x\n  return t\n}\n" },
    head: { "src/sum.ts": "/** The sum of `values` (0 for none). */\nexport function sum(values: number[]): number {\n  let total = 0\n  for (const value of values) total += value\n  return total\n}\n" },
    defects: [],
  },
]
