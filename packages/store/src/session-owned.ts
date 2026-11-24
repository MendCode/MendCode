/** A write to a session another machine owns through session sync (docs/sync.md); the message names that machine. */
export class SessionOwnedElsewhere extends Error {
  override name = "SessionOwnedElsewhere"
}
