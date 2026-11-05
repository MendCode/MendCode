/** Idle days the daily worktree pass uses when `worktreeGcDays` is unset. */
export const DEFAULT_WORKTREE_GC_DAYS = 14
/** Days the daily pass waits before removing a worktree: the setting, 14 when unset, undefined when it is 0 (off). */
export const effectiveWorktreeGcDays = (setting: number | undefined) => (setting === undefined ? DEFAULT_WORKTREE_GC_DAYS : setting === 0 ? undefined : setting)
/** `worktreeCapGb` in bytes (GiB). */
export const worktreeCapBytes = (capGb: number | undefined) => (capGb ? capGb * 1024 ** 3 : undefined)
