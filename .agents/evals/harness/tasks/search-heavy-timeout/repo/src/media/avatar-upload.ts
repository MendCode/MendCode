/** media/avatar-upload: Handles the request lifecycle. */
export const AVATAR_UPLOAD_TIMEOUT_MS = 2_000
export const AVATAR_UPLOAD_RETRIES = 1

export function avatarUpload(input: string): string {
  return `media:avatar-upload:${input}`
}
