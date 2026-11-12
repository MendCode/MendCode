/**
 * What the chat bridge needs from a chat service (Telegram, Discord). Ids are strings: Discord's snowflakes do not fit a JS number.
 * A "topic" is a Telegram topic of the private chat with the bot, or a Discord thread of the paired channel.
 */
export type ChannelService = "telegram" | "discord"

/** A button answers the bot (`data`) or opens a link (`url`, such as a topic's link). */
export type ChannelButton = { text: string; data: string } | { text: string; url: string }
/** Where a message goes: the chat, or one topic of it; `markdown` sends the text formatted. */
export type ChannelSend = { thread?: string | undefined; markdown?: boolean | undefined }
export type ChannelVoice = { file: string; duration?: number | undefined; size?: number | undefined; mime?: string | undefined }

export type ChannelApi = {
  /** Sends `text` in parts under the service's size limit; resolves to the id of the last part (what `editMessage` can change). */
  sendMessage(chat: string, text: string, buttons?: ChannelButton[][], options?: ChannelSend): Promise<string | undefined>
  /** Answers a button press; `text` is shown only to the person who pressed it. */
  answerCallback(id: string, text?: string): Promise<unknown>
  sendTyping(chat: string, thread?: string): Promise<unknown>
  sendDocument(chat: string, file: { name: string; bytes: Uint8Array; caption?: string }, thread?: string): Promise<unknown>
  downloadFile?(file: string, maxBytes: number): Promise<Uint8Array>
  /** Replaces a message's text (the live progress line); text past the limit is cut, never split. */
  editMessage?(chat: string, messageId: string, text: string, thread?: string): Promise<unknown>
  /** A new topic of `chat`, started from the message `fromMessage` when given; resolves to its thread id. */
  createTopic?(chat: string, name: string, fromMessage?: string): Promise<string>
  /** Whether topics can be opened now (Telegram: topic mode on in @BotFather); read again while it is off. */
  topicsEnabled?(): Promise<boolean>
  /** A link that opens the topic, when the service has one. */
  topicLink?(chat: string, thread: string): string | undefined
}

/** One incoming message or button press, already placed: `chat` is the paired chat or channel, `thread` the topic in it. */
export type ChannelUpdate =
  | { kind: "message"; chat: string; thread?: string | undefined; messageId?: string | undefined; from: string; label?: string | undefined; allowed: boolean; text?: string | undefined; voice?: ChannelVoice | undefined }
  | { kind: "press"; id: string; chat: string; thread?: string | undefined; from: string; allowed: boolean; data?: string | undefined }

/** The words a service uses, so every reply reads the way that app calls things. */
export type ChannelWords = { topic: string; topics: string; pairHint: string; topicsHint: string }
