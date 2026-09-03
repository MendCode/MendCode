import { describe, expect, test } from "bun:test"
import { createClient } from "../../../sdk/js/src/gen/client/client.gen"

describe("generated V1 SDK SSE transport", () => {
  test("uses the client-configured fetch implementation", async () => {
    const requests: Request[] = []
    const customFetch = async (request: Request) => {
      requests.push(request)
      return new Response('data: {"ok":true}\n\n', {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    }
    const client = createClient({ baseUrl: "https://sdk.example.test", fetch: customFetch })

    const result = await client.get.sse({ url: "/events" })
    const next = await result.stream.next()

    expect(next).toEqual({ value: { ok: true }, done: false })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("https://sdk.example.test/events")
  })
})
