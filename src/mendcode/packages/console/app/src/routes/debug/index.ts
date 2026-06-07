import type { APIEvent } from "@solidjs/start/server"
import { json } from "@solidjs/router"
import { Database } from "@mendcode/console-core/drizzle/index.js"
import { UserTable } from "@mendcode/console-core/schema/user.sql.js"

export async function GET(_evt: APIEvent) {
  return json({
    data: await Database.use(async (tx) => {
      const result = await tx.$count(UserTable)
      return result
    }),
  })
}
