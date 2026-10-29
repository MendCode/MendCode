import { retry, type Sleep } from "./retry"

export type Delivery = (url: string) => Promise<number>

export function webhookEndpoint(name: string): string {
  return `https://api.example.test/v2/hooks/${encodeURIComponent(name)}`
}

/** Deliveries retry like API reads do: three more tries, a quarter of a second apart. */
export async function deliverWebhook(name: string, deliver: Delivery, sleep?: Sleep): Promise<number> {
  return retry(
    async () => {
      const status = await deliver(webhookEndpoint(name))
      if (status >= 500) throw new Error(`webhook ${name} failed with ${status}`)
      return status
    },
    { retries: 3, delayMs: 250, ...(sleep ? { sleep } : {}) },
  )
}
