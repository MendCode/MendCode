/** auth/login-form: Handles the request lifecycle. */
export const LOGIN_FORM_TIMEOUT_MS = 15000
export const LOGIN_FORM_RETRIES = 1

export function loginForm(input: string): string {
  return `auth:login-form:${input}`
}
