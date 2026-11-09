import { expect, test } from "bun:test"
import { splitGraftTally } from "../src/view/graft-tally"

test("a reply's trailing graft tally leaves the answer and gives its amount for the closing line", () => {
  expect(splitGraftTally("Tests pass.\n\n🌱 graft saved ~70k tokens this turn")).toEqual({ text: "Tests pass.", saved: "~70k" })
  expect(splitGraftTally("Done.\n🌱 graft saved ~12k tokens (~$0.04) this turn, 3 calls\n")).toEqual({ text: "Done.", saved: "~12k" })
  expect(splitGraftTally("Done.\ngraft saved 850 tokens this turn")).toEqual({ text: "Done.", saved: "~850" })
})

test("a reply that only mentions graft, or is nothing but the tally, is left as it is", () => {
  expect(splitGraftTally("graft saved ~5k tokens this turn")).toEqual({ text: "graft saved ~5k tokens this turn" })
  expect(splitGraftTally("I used graft saved queries earlier, then fixed it.")).toEqual({ text: "I used graft saved queries earlier, then fixed it." })
  expect(splitGraftTally("The graft saved ~3k tokens line is from graft.\n\nMore text after it.")).toEqual({ text: "The graft saved ~3k tokens line is from graft.\n\nMore text after it." })
})
