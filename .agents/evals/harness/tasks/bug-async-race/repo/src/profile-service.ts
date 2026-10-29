import { memoizeAsync } from "./memoize-async"

export type Profile = { id: string; name: string }

/** Profile lookups hit a slow remote store, so identical requests must not repeat. */
export function createProfileService(fetchProfile: (id: string) => Promise<Profile>) {
  const lookup = memoizeAsync(fetchProfile)
  return {
    profile: (id: string) => lookup(id),
    forget: () => lookup.clear(),
  }
}
