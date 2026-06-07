import type { APIEvent } from "@solidjs/start"
export async function GET({ params: { platform, channel } }: APIEvent) {
  return Response.json(
    {
      ok: false,
      platform,
      channel,
      message: "MendCode desktop downloads are not published yet.",
    },
    { status: 404 },
  )
}
