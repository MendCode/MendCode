# Context, cache and computer tools

MendCode records a small profile for each completed model step. Inspect recent
profiles from the same workspace as the session:

```sh
mendcode context <sessionID>
mendcode context <sessionID> --limit 50 --json
```

The report separates estimated instruction, recalled memory, conversation,
tool-result, tool-schema and media tokens. These estimates are not provider
billing counts. Actual input/cache counts come from provider usage; missing
fields remain unavailable. Timing measures the request and first streamed text
or reasoning event. Fingerprints identify stable instruction/schema prefixes
without retaining their contents in the profile. Existing sessions gain profiles
only for new completed steps. The command reads a bounded recent-message page,
not a lifetime total.

Memory retrieval is stored as synthetic reference context at each user turn.
Repeated tool steps reuse that snapshot; the next user turn retrieves memory
again. Synthetic memory never grants permission or replaces the user's request.

## Tool discovery

Core tools retain their direct interfaces. Secondary tools are discovered with
`tool_search`; returned schemas enable direct calls in subsequent steps. Search
returns at most eight schemas and 24 KiB. Up to 64 secondary tools remain active
in retained history. Disabled tools stay unavailable. Schemas too large for the
search budget are omitted, not truncated into invalid definitions.

Set `experimental.tool_discovery` to `false` in the existing MendCode JSON
configuration to send the complete permitted catalog. Disabling `tool_search`
also restores the complete catalog so capabilities do not become inaccessible.
Cache savings depend on the provider and workload; no measured saving or parity
with another harness is claimed.

## Experimental Code Mode

Enable `experimental.code_mode: true` to expose `code`. It runs a confined
JavaScript subset in a worker. Use `tools.search({query: "..."})` to discover
signatures, call tools with `await tools.name(args)`, and return a concise value:

```js
const result = await tools.read({ filePath: "/workspace/report.txt" })
return { characters: result.output.length }
```

The host enforces 32 KiB source, 16 tool calls, a 30-second wall-clock deadline
and 24 KiB retained result/log output. Every nested call uses the existing tool
implementation, permissions and session audit record. Its intermediate result
stays out of model history; only the outer result enters it. Call image-producing
tools directly to view images. Cancellation waits for host tool cleanup.

There are no process, filesystem, network or import globals in the language.
Worker separation is not an OS sandbox or a hard heap quota. Code Mode remains
off by default pending broader resource, permission and packaged-runtime testing.
The interpreter is adapted from OpenCode v2 at revision
`cd504dc66ac6620a662a0246f83cfc05f796f58a`; its MIT license and file provenance
are kept alongside the source. No dependency upgrade is required.

## Native macOS screenshots and navigation

`computer_capture` captures the main display, an explicit window ID, or an
integer screen-region crop. It returns a PNG attachment and an absolute file
path that `read` can reopen. Previews are resized to at most 1600 pixels;
coordinates in them must not be assumed to match desktop control coordinates.
Retained identical screenshots reuse the existing image reference. Capture
artifacts are limited to 64 per session and 8 MiB per inline image.

`computer_key` supports one navigation key against the foreground application
observed during a recent full-display capture on a single-display Mac. The
capture ID belongs to the same session, expires after 30 seconds and permits
one action. Foreground changes, stale captures and missing observations fail
closed. The tool never activates another application. Capture again afterward.
Window crops, multiple displays, pointer control and arbitrary typing do not
support this keyboard-control path.

Both tools use the normal MendCode permission boundary. macOS Screen Recording,
Automation and Accessibility permissions remain controlled by the OS; failures
are reported rather than bypassed. Native support on Windows/Linux and browser
DOM automation are not included. Connected MCP services remain discoverable.

## Compaction compatibility

The existing portable summarizer remains active. The installed OpenAI SDK can
replay encrypted reasoning but does not expose native `/responses/compact`
replacement-window support. Encrypted reasoning is not treated as a compaction
checkpoint. No native compaction request, history replacement, model change or
new provider credential path is enabled by this change. Native compaction needs
a separate transport capability, durable replay contract and interruption tests
before it can be accepted.

## Verification scope

Focused local tests cover profiles and missing usage, discovery, common provider
request fixtures, Code Mode confinement/deadline/cancellation, and a session
using a nested file read with final-output-only model input. Native screenshot
capture and image decoding were exercised on macOS. Interactive keyboard
control, packaged worker execution, provider-native compaction and paid/live
provider behavior remain unverified. This is not a claim of complete computer
use or cache-performance equivalence.
