# Browser tool

Multi-tab actions: `tabs` lists this chat's cached tab IDs, title and URL without starting Chromium; `open_tab {url}`
opens a tab (execute approval), `select_tab {tabId}` selects it and `close_tab {tabId}` closes it. IDs cannot address
another chat's tabs. Each tab has isolated cookies/storage; the cap is 8 per chat. Take a new snapshot for refs after
switching. `close` and session teardown close all owned tabs. Tests use a fake CDP driver with no network calls.
The new tab controls are refused for remote/peer model turns before accessing a page or starting Chromium.

The model can drive a headless Chromium to check web pages and apps: your local dev server, a deployed
site, documentation. It is **off by default**. Start the daemon with `MENDCODE_BROWSER=1` and an explicit
`--dir`; the `browser` tool is then registered (it is also a core tool under [tool discovery](tool-discovery.md)).
Disable it again per project with `tools: { browser: false }` or `permission: { browser: "deny" }`.

No dependency or service is added. The daemon launches the Chrome, Chromium, Edge or Brave already on the
machine (macOS app folders, then `google-chrome`, `chromium`, `microsoft-edge`, `brave-browser` on PATH) with an
argument array, a throwaway profile directory and a debugging port bound to `127.0.0.1`. Set
`MENDCODE_BROWSER_PATH` to pick the executable. Without a browser the tool says so. It speaks the DevTools
protocol over Bun's built-in WebSocket.

## Actions

`browser { action, ... }`

| Action | Arguments | Result |
|---|---|---|
| `navigate` | `url` (http or https) | page URL and title once loaded |
| `snapshot` | | page text (8,000 chars) plus up to 300 numbered interactive elements, e.g. `[3] button "Save"`, `[5] input:text "Email" value="..."` |
| `click` | `ref` | real mouse click at the element; refuses a covered, hidden or disabled one |
| `type` | `ref`, `text`, `submit?`, `append?` | replaces the field (or appends); `submit` presses Enter; on a `<select>` picks the option by label or value |
| `press` | `key` | Enter, Tab, Escape, Backspace, Delete, arrows, Home, End, PageUp, PageDown, Space |
| `scroll` | `direction` | one viewport up or down |
| `back` | | previous history entry |
| `wait` | `ms?`, `text?` | sleeps, or waits for text to appear (default 10 s) |
| `screenshot` | | PNG of the 1280x800 viewport as an image the model sees (JPEG if over 5 MB) |
| `console` | | console output, page errors and failed resources since the last check (bounded to 200 entries) |
| `close` | | closes this chat's browser |

Refs come from the latest snapshot and stop working when the page navigates or the element goes away; the
model snapshots again. Passwords and card or one-time-code fields never show their value in a snapshot. Typed
text is not echoed in results or card titles. JavaScript dialogs are dismissed and logged to the console buffer.
Downloads are denied. A link that opens a new tab is opened in the same tab.

## Isolation and limits

One browser process serves the daemon; each chat session gets its own context (own cookies, storage and cache)
and one page. A chat cannot see another's pages. At most 4 chats hold a browser (the next is refused until one
closes), calls of one chat never overlap, an idle browser closes after 10 minutes, a page lives at most an hour,
and deleting the session, `close`, or stopping the daemon closes the context. The process exits with its last
page; a crashed browser is relaunched on the next call. Only `http:` and `https:` pages load: `file:`,
`javascript:`, `data:`, `chrome:` and URLs with embedded credentials are refused, so the tool cannot read local
files. Page content is returned labelled as untrusted web content, never as instructions.

## Permissions

The tool has its own approval class, `browser`. Looking at the open page (`snapshot`, `screenshot`, `console`,
`scroll`, `wait`, `close`) is `read`; `navigate`, `click`, `type`, `press` and `back` are `execute`, so plan mode
refuses them and ask mode asks first (edits and smart modes treat it as any `execute` tool). The approval shows
the URL, or the element and the text to type. Permission rules match a navigation by its URL and other steps by
their action name (`click`, `type`...), so a pattern rule saved from a click approval never covers opening pages.
Approving "for this session" is, as for `shell`, a grant for the whole tool:

```json
{ "permission": { "browser": { "https://*": "deny", "http://localhost:*": "allow" } } }
```

(Rules are matched last-wins; a lone `"*": "deny"` disables the whole tool.) Navigation is the approval
boundary: once a page is open, links it contains are followed by `click` under the click approval. Use
`https://*` deny rules, or ask mode, when that matters.

The browser is reachable only from a model turn. There is no HTTP route, wire command or ticket for it, so remote
and peer clients have no way to drive it, and nothing was added to `READ_ONLY_COMMANDS`. Screenshots and
snapshots can contain sensitive page content and are stored in the session like any tool image.

## Decisions and limits

- Opt-in by environment variable, like `MENDCODE_COMPUTER`; no new setting or key. Tests use a fake DevTools
  endpoint and a loopback WebSocket; `MENDCODE_BROWSER_E2E=1 bun test packages/daemon/test/browser-e2e.test.ts`
  drives a real installed Chromium against a loopback page.
- No arbitrary JavaScript evaluation, file upload, downloads, cross-origin iframe content, shadow DOM or
  multi-tab control. These need a separate, stronger approval class than this conservative first version.
- The browser's own Chromium sandbox is on; `--no-sandbox` is passed only when the daemon runs as root.

## Your own browser (extension)

The `browser` tool above drives a headless Chromium of its own. `user_browser` is the other half: it works in the
browser you already use (Chrome, Arc, Brave, Edge, Chromium) through a MendCode extension, in background tabs of a tab
group titled "MendCode", so you keep browsing and focus is never taken. It needs no Accessibility permission. It is
**off by default**: start the daemon with `MENDCODE_BROWSER_EXTENSION=1` (feature `browser`, full tier). Until you also
install the extension, nothing listens and nothing is written.

| Action | Approval | Result |
|---|---|---|
| `status` | none | installed, connected, allowed sites |
| `install` | execute | writes the files below; the model asks you with a question first |
| `allow_site {origin}` | execute | adds the site to MendCode's list |
| `open {url}` | execute | opens it in the MendCode group, in the background (site must be allowed) |
| `tabs`, `read {tabId}`, `close {tabId}` | none | the group's tabs, a tab's page text (labelled untrusted), close it |
| `click {tabId, selector}`, `type {tabId, selector, text, submit?}` | execute | by CSS selector; password, card and one-time-code fields are refused |

`install` writes, and returns the list of, these files (macOS and Linux; Windows needs a registry entry and is not
supported yet): the extension folder, `host.mjs` and `host.sh` and `installed.json` under `<data dir>/browser/`, and one
`NativeMessagingHosts/com.mendcode.browser.json` per browser whose profile folder exists. Then load the extension once:
`chrome://extensions`, Developer mode, Load unpacked, pick `<data dir>/browser/extension`, and restart the browser.

How it connects: the browser starts `host.sh` (a stdio native messaging host) when the extension asks; the host only
joins stdio to the daemon's socket `<data dir>/browser/bridge.sock` (mode 0600, listening only while the bridge is
enabled and installed). Messages are 4-byte little-endian length plus JSON in both directions. The extension's first
message carries a per-install token the daemon checks; a wrong token is dropped.

Security: a site works only when **both** sides agree: MendCode's list (`allow_site`, approved by you) and the browser's
own optional host permission (the extension's toolbar button, on that site, which needs your click). The extension acts
only on tabs it opened itself, inside its group; your own tabs are never read or driven. It holds no `cookies`
permission and fills no password, card or one-time-code field. Page text is returned labelled as untrusted web content.
Tests use fake sockets and temp directories; nothing touches a real browser.

Not yet: Firefox and Safari, Windows, a CLI install command, and keeping remote/peer turns away from the tool.
