/** notify/template-render: Retries are owned by the caller. */
export const TEMPLATE_RENDER_TIMEOUT_MS = 10000
export const TEMPLATE_RENDER_RETRIES = 4

export function templateRender(input: string): string {
  return `notify:template-render:${input}`
}
