# File reads and attachments

`read { path, offset?, limit? }` reads text, directories, PNG/JPEG/GIF/WebP images and PDFs. Text keeps
1-based line numbers; offset/limit also page sorted directory entries (directories end in `/`). The default
is 2,000 lines/entries, with bounded output and a continuation offset. Long text lines stop at 2,000 characters.
Inline images/PDFs are sniffed by bytes and limited to 5 MiB per file. Binary files and special files are rejected.

Nearby `AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md`, or legacy `CONTEXT.md` below the session directory accompany
file reads as a system reminder (first match per directory, outermost first, `@include` lines followed, at most 16 KB).
This is the same loader as the system prompt's ([instruction files](resources-config.md#instruction-files)), so file
precedence, includes, limits and the fallback and root-marker settings agree. Native history remembers each loaded file
and its version (path, mtime and size): re-reading does not repeat unchanged instructions, an edited file is injected
again, and compaction can make them eligible again. Root/global instructions are in the system prompt.

`/attach <path>` and dropped/pasted paths use the daemon. Project files/directories insert `@path` (quoted for
spaces). External text files are inlined up to 200 KiB; external directories are bounded sorted listings.
Existing pasted-image limits remain 20 MiB; pasted PDFs have the 5 MiB limit.

Bracketed text pastes remain literal across stdin reads. Empty paste events do nothing; only the
explicit clipboard action probes images and reports a missing image. Successfully attached pasted
paths become attachments and do not remain as raw escaped prompt text.

## Long pastes

A message is at most 64 KB of text. When the pastes in the prompt make it longer, Enter sends the largest of them as text
attachments (`text/plain`, up to 4 MiB each, `attachment.put` in pieces of 140 KB) until the rest fits; each keeps its
`[Pasted Content N chars]` label in the message, the transcript shows that label and a `txt` chip, and the model reads the whole
text right where the label stands, in that turn and in every later one. The native engine reads it from the attachment (in the
ordered parts and in the plain text, so every provider gets it); Claude Code, Codex, pi and ACP agents get it put back into the
message text, including a message that joins a running turn. Text typed by hand (not pasted) over 64 KB, or a single paste over
4 MiB, is not sent: the prompt stays as it was and says why.

## Inline tokens

An attachment that is not a project mention enters the prompt as a token at the cursor, where it will be read:
`[Image #1]` for an image (numbered on from the images the session already sent: after three, the next is `[Image #4]`), `[PDF design-spec.pdf]`, `[notes.txt]` for an external text file, `[codeconfig/]` for a
folder. This holds for a paste, a drop (several paths land in drop order, one space apart), `/attach` and the clipboard
key. A space is added only where one is needed: pasted in the middle of a word, the token is set off by spaces; after
a space, no second space. The token is one character for the editor ([docs/editor.md](editor.md#attachment-tokens)):
the cursor never rests inside it, and a delete, cut, word motion or selection takes it whole. Deleting the token
removes its attachment; undo brings both back. Image numbers go up and are not reused while their token can come back.
A name with brackets, line breaks or more than 28 cells is made safe and shortened (it keeps its extension); a second
`[PDF a.pdf]` is `[PDF a.pdf #2]`. A refusal (not a file, over the limit, an unsupported type) is one line and inserts
nothing, token or path.

The setting `attachmentChips` (`/customize`, "Attachments") chooses where an attachment shows while the message is
written:

| value | prompt text | chip row over the prompt |
|---|---|---|
| `inline` (default) | the token | only attachments with no token (an older draft) |
| `above` | no token; the attachment goes after the text, as before tokens existed | every attachment, with name and size |
| `both` | the token | every attachment |

In the transcript the sent message draws a token as a chip in the colour of its kind (image accent, PDF primary, text
and folders secondary) inside the sentence, kept on one row when it wraps. The `■ name` list under a message names
only the attachments the sentence does not show.

### What the model receives

The terminal sends the text with the tokens in it. Each image or PDF ref carries two additive fields: `label` (the token,
at most 80 characters) and `at` (the offset in the sent text right after the token). `user.submit` refuses an `at`
without a `label`, past the end of the text, before the end of its label, or on a token another ref already holds.
A text file or folder is not a ref: its fenced block (`[attached file: name]`) is placed after its token, so the sentence
reads in order, and the text after it resumes on a fresh paragraph. Refs without `label` and `at` (the `above` setting,
an old client, an old draft or queue entry) are sent after the text exactly as before; a request for a message without
attachments is byte for byte unchanged.

The label is the anchor, `at` only a hint: the daemon rewrites text (secret masking, `@thread`, hooks, IDE context), so
the ref is placed where its label stands, preferring the offset when the label is there, then the first free occurrence
of the label. An attachment whose label is no longer in the text goes at the end, in its own order.

| engine | content sent |
|---|---|
| native, OpenAI Responses | `input_text`, `input_image` / `input_file`, `input_text`, in token order |
| native, Chat Completions | `text`, `image_url` / `file`, `text` parts |
| native, Anthropic Messages | `text`, `image` / `document`, `text` blocks (a text block of only spaces between two tokens is left out; the API refuses it) |
| native, Gemini | `text` and `inlineData` parts |
| Claude (stream-json), ACP | text up to and including each token, then its image block; an ACP agent that takes no images gets the text marker `[attachment name · mime · not sent]` at that place |
| pi | cannot interleave: the text keeps its tokens and the images follow in the order of the tokens |
| codex | text only; the tokens stay in it and attachments are not sent, as before |

The history keeps the refs with their `label` and `at` and no bytes; the interleaved request shape is built when the
request is sent, so compaction, recall, export and a model switch (a model without vision drops the images and keeps the
text and its tokens) work from the stored message. Drafts, the prompt stash, queued prompts, undo and edit-and-resend
carry the refs with their tokens; data written before tokens (refs with no label) still loads and is sent after the
text. The prompt history (up-arrow) keeps text only, as it always has: a recalled `[Image #1]` is plain text that no
attachment stands behind.

Native `@path` mentions resolve files and directories within the project, including quoted names. Symlinks
escaping the root are omitted. Text is bounded at 100 KiB per file / 300 KiB per message; directories show
at most 200 entries and share that byte budget. There are at most 32 distinct paths, and inline media is
bounded at four files / 20 MiB total (5 MiB each). Missing files remain literal mentions; skipped binary or
over-limit files get a reason. `@file?start=10&end=20` reads an inclusive line range. Nearby instructions
load once for mentions too. Text content passes through the session secret masker before persistence.

The native engine stores media as session-owned blobs and resolves bytes only for model requests.
Tool results allow at most two media attachments / 5 MiB each. PDF uses `input_file` in Responses,
`document` in Anthropic, and `file` in Chat Completions; an endpoint/model must support that file input.
These wire formats follow the [OpenAI file-input contract](https://developers.openai.com/api/docs/guides/file-inputs)
and [Anthropic PDF contract](https://platform.claude.com/docs/en/build-with-claude/pdf-support).
No provider service is contacted to classify or store files. External engine file handling is independent.

`attachment.paste` has an additive `document` result carrying `BlobRef` and name. The client helper is
`pasteAttachment(path, directory?)`. Attachment commands remain unavailable to read-only peers.

`attachment.read` (`sessionId`, `sha256`, optional `offset`) returns one chunk of a blob the session's own events reference, for drawing
images in the transcript (`layout.md`): `{ sha256, mime, bytes, offset, data (base64, at most 96 KB), done }`. A hash the session does not hold is
`target_mismatch`, an offset past the end `invalid_command`; it takes no path, is refused for remote and peer clients (`forbidden`) and is not a read-only command.
