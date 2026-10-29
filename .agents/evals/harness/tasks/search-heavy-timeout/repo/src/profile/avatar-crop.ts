/** profile/avatar-crop: Keeps the hot path allocation free. */
export const AVATAR_CROP_TIMEOUT_MS = 10_000
export const AVATAR_CROP_RETRIES = 4

export function avatarCrop(input: string): string {
  return `profile:avatar-crop:${input}`
}
