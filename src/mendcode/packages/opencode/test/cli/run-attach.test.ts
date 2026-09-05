import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import path from "node:path"

test.each(["completed", "failed", "http-rejected"])(
  "attached run stays client-only and exits after %s",
  async (outcome) => {
    const failed = outcome === "failed"
    const base = path.join(process.env.XDG_DATA_HOME!, `run-attach-${outcome}`)
    const db = path.join(base, "runtime.db")
    const sessionID = "ses_fixture"
    let events: ReadableStreamDefaultController<Uint8Array> | undefined
    let prompt: unknown
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url)
        if (url.pathname === "/event")
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                events = controller
                controller.enqueue(new TextEncoder().encode(": connected\n\n"))
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        if (url.pathname === "/session") return Response.json({ id: sessionID })
        if (url.pathname === "/config") return Response.json({ share: "disabled" })
        if (url.pathname === `/continuity/${sessionID}/model-resolution`) {
          expect(await request.json()).toEqual({ explicitModel: "fixture/model" })
          return Response.json({
            agent: "build",
            model: { providerID: "fixture", modelID: "model" },
            source: "explicit",
          })
        }
        if (url.pathname === `/session/${sessionID}/message`) {
          prompt = await request.json()
          if (outcome === "http-rejected") return Response.json({ message: "Fixture HTTP failure" }, { status: 500 })
          if (failed)
            events!.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  type: "session.error",
                  properties: {
                    sessionID,
                    error: { name: "UnknownError", data: { message: "Fixture failure" } },
                  },
                })}\n\n`,
              ),
            )
          events!.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                type: "session.status",
                properties: {
                  sessionID,
                  status: { type: "idle" },
                },
              })}\n\n`,
            ),
          )
          return Response.json({})
        }
        return new Response("Unexpected fixture request", { status: 404 })
      },
    })
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "--conditions=browser",
        "src/index.ts",
        "run",
        "--attach",
        server.url.origin,
        "--model",
        "fixture/model",
        "--format",
        "json",
        "Fixture prompt",
      ],
      {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          MENDCODE_DB: db,
          OPENCODE_DB: db,
          XDG_DATA_HOME: base,
          XDG_CONFIG_HOME: path.join(base, "config"),
          XDG_STATE_HOME: path.join(base, "state"),
          XDG_CACHE_HOME: path.join(base, "cache"),
          HOME: path.join(base, "home"),
          OPENCODE_TEST_HOME: path.join(base, "home"),
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const timer = setTimeout(() => child.kill(), 15_000)
    try {
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(code).toBe(outcome === "completed" ? 0 : 1)
      if (outcome === "http-rejected") expect(stdout).not.toContain("session.completed")
      else {
        expect(stderr).toBe("")
        expect(stdout).toContain("session.completed")
        expect(stdout).toContain(failed ? '"status":"failed"' : '"status":"completed"')
      }
      expect(prompt).toMatchObject({ agent: "build", model: { providerID: "fixture", modelID: "model" } })
      expect(existsSync(db)).toBe(false)
      expect(existsSync(`${db}.writer-lock`)).toBe(false)
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
      server.stop(true)
    }
  },
  20_000,
)
