import { describe, expect, test } from "bun:test"
import { resumeImageParts } from "../../src/session/compaction"
import type { MessageV2 } from "../../src/session/message-v2"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, PartID, SessionID } from "../../src/session/schema"

const sessionID = SessionID.make("ses-image")
const providerID = ProviderID.make("test")
const modelID = ModelID.make("vision")
const messageID = MessageID.make("msg-image")

describe("compaction attachment restore", () => {
  test("restores a compacted image reference with mime, URL and source metadata", () => {
    const source = {
      type: "file" as const,
      path: "assets/screen.png",
      text: { value: "assets/screen.png", start: 0, end: 17 },
    }
    const messages: MessageV2.WithParts[] = [
      {
        info: {
          id: messageID,
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.make("part-image"),
            messageID,
            sessionID,
            type: "file",
            mime: "image/png",
            filename: "screen.png",
            url: "data:image/png;base64,AA==",
            source,
          },
        ],
      },
    ]

    const restoredMessageID = MessageID.make("msg-resume")
    const restored = resumeImageParts(messages, restoredMessageID, sessionID)
    expect(restored).toHaveLength(1)
    expect(restored[0]).toMatchObject({
      type: "file",
      mime: "image/png",
      filename: "screen.png",
      url: "data:image/png;base64,AA==",
      source,
      messageID: restoredMessageID,
      sessionID,
    })
  })

  test("keeps a missing external reference explicit for provider-side handling", () => {
    const messages: MessageV2.WithParts[] = [
      {
        info: {
          id: MessageID.make("msg-missing-image"),
          sessionID,
          role: "user",
          time: { created: 1 },
          agent: "build",
          model: { providerID, modelID },
        },
        parts: [
          {
            id: PartID.make("part-missing-image"),
            messageID: MessageID.make("msg-missing-image"),
            sessionID,
            type: "file",
            mime: "image/png",
            url: "file:///missing/screen.png",
          },
        ],
      },
    ]
    expect(resumeImageParts(messages, MessageID.make("msg-resume"), sessionID)[0]?.url).toBe("file:///missing/screen.png")
  })
})
