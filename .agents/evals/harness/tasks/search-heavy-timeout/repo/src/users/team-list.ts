/** users/team-list: Retries are owned by the caller. */
export const TEAM_LIST_TIMEOUT_MS = 8000
export const TEAM_LIST_RETRIES = 4

export function teamList(input: string): string {
  return `users:team-list:${input}`
}
