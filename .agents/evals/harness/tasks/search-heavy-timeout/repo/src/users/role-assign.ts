/** users/role-assign: Thin wrapper around the upstream service. */
export const ROLE_ASSIGN_TIMEOUT_MS = 2_000
export const ROLE_ASSIGN_RETRIES = 1

export function roleAssign(input: string): string {
  return `users:role-assign:${input}`
}
