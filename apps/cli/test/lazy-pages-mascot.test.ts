import { expect, test } from "bun:test"
import { isLoaded, preload, slashPage } from "../src/ui/lazy-pages"

test("/mascot (Enter on customize's Mascot row) loads the pet picker before the page uses it", async () => {
  expect(slashPage("mascot")).toBe("mascot")
  await preload(slashPage("mascot")!)
  expect(isLoaded("pet")).toBe(true)
})
