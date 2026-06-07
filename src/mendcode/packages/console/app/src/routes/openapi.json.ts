export async function GET() {
  return new Response(JSON.stringify({ error: "MendCode OpenAPI export is not published yet." }), {
    status: 404,
    headers: { "content-type": "application/json" },
  })
}
