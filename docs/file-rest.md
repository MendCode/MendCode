# File/find REST adapter (B35)

The existing [HTTP adapter](remote.md#http-adapter-b34) is off by default, loopback-only and token-authenticated. All six routes require a full token, including reads: source text, images, names and symbols are private project data. `file.rest.read` is excluded from `READ_ONLY_COMMANDS`. There are no new dependencies, downloads or terminal screens.

| GET route | Query | Response / operation ID |
|---|---|---|
| `/find` | `pattern` (regex) | ripgrep JSON matches: `path.text`, `lines.text`, 1-based `line_number`, byte `absolute_offset`, byte `submatches` / `find.text` |
| `/find/file` | `query`, `dirs=true\|false`, `type=file\|directory`, `limit=1…200` (default 10) | Fuzzy-ranked paths, directories ending in `/` / `find.files` |
| `/find/symbol` | `query` | `{name, kind, location: {uri, range}}[]`, 0-based LSP positions / `find.symbols` |
| `/file` | `path` (empty for root) | Directory-first `{name, path, absolute, type, ignored}[]` / `file.list` |
| `/file/content` | `path` | `{type: text\|binary, content, diff?, patch?, encoding?, mimeType?}` / `file.read` |
| `/file/status` | — | `{path, added, removed, status: added\|deleted\|modified}[]` / `file.status` |

All queries require their named fields; empty text/name/symbol queries and root paths are accepted. Unknown or repeated query parameters are rejected. Select an existing registered project using `directory`/`x-opencode-directory` or `workspace`/`x-mendcode-workspace`; unknown or conflicting selectors return 403. OpenAPI includes the donor operation IDs, response schemas and query bounds.

Text search uses installed ripgrep with hidden files, project ignore rules, no user rg configuration, no symlink following and ten matching lines **per file**, as v1 does. File search uses the same project inventory. Empty queries default to directories; `dirs=false` or `type=file` requests files. Explicit type wins over dirs. Hidden directories sort last unless explicitly searched. Successful content reads persist bounded frequency/last-open metadata under `<data dir>/file-frecency.json`; empty file queries and fuzzy matches prioritize recent frequent opens with v1's daily decay.

Listings omit `.git`, `.DS_Store`, external symlinks and non-regular files. Git owns `.gitignore` matching (including nested rules); root `.ignore` rules apply afterward. Content reads deny traversal and external symlinks, including absent descendants of symlinked directories. Missing files return `{type: text, content: ""}`. Text is trimmed as in v1; images are base64 with MIME type; binary files return empty binary content. Changed text includes a full-context structured patch from HEAD to the returned text, including staged changes, whitespace-insensitive line matching and EOF markers. Neither Git diff drivers nor textconv run.

Status compares the selected directory to HEAD, includes staged and unstaged changes plus untracked files, preserves NUL-delimited filenames and handles unborn repositories. Deleted files have one `deleted` row with zero counts; v1's duplicated modified/deleted entries are normalized. Non-Git projects return `[]`. No index refresh, fetch or project-file write occurs.

Symbol discovery queries only live LSP servers rooted inside the selected project: ten relevant symbols per server, filtered to valid in-project file URIs. It never starts a server or provisions a binary. A cold/unconfigured project returns `[]`, matching v1's current empty HTTP handler; connect servers with the existing [LSP](lsp.md) tool to enable useful results. Server failures are explicit if no server succeeds. Local fake-server tests require no external service.

Requests have a five-second operation deadline. File reads are capped at 120,000 bytes; inventories at 50,000 paths; listings/status at 2,000 entries; subprocess stdout at 8 MiB, stderr at 16 KiB; JSON responses fit the existing 256 KiB frame. Line diffs have a bounded work budget. Limits return 400 rather than silently truncating a donor payload. Missing ripgrep returns 501; it is never downloaded. Native clients use `client.filesApi(directory, input)` with one of the six operation IDs and receive typed `{ok, value}` results.

## Terminal viewer (`file.view`)

The terminal's [file viewer](file-viewer.md) does not use `/file/content`: that read fails above 120,000 bytes, trims content and has no redaction or windowing. It sends the native read-only command `file.view` (a bounded window of lines, containment and symlink checks like the routes above, secrets masked, `stat` before opening so devices and pipes are never read). Read-only peers may send it.

## Browser editor (`file.edit`)

The six routes above are read-only and trimmed. The [web client](remote.md)'s Files pane needs exact text and a save, so there is one native command, `file.edit`, sent through `/command` (also `client.fileEdit(directory, input)`). It is **off by default**: `serve/web --edit` or `{"server":{"edit":true}}` in `remote.json` enables it, otherwise it returns 501 and the pane is a read-only viewer. It needs a full token and is not in `READ_ONLY_COMMANDS`.

| Input | Result |
|---|---|
| `{operation: "read", path}` | `{path, content, sha256, bytes}`: exact UTF-8 text, no trimming; a missing file is `content: ""`, `sha256: null` |
| `{operation: "write", path, content, expected}` | `{path, sha256, bytes}`; `expected` must equal the file's current sha256 (`null` to create), so an agent or another tab changing the file makes the save fail with "File changed on disk" instead of overwriting |

Paths follow the file API rules (inside the selected project, no external symlinks, traversal is 403) and `.git` is never readable or writable here. Files must be valid UTF-8 without NUL and at most 120,000 bytes; directories are not created (missing parent is 400). A write goes to a temp file in the same directory and is renamed over the target, keeping the file mode. Edits are made as the token's user and bypass agent approvals, like any other client action, which is why the opt-in exists.

B35 adds no UI. The existing conversation renderer is exercised with local API fixtures (these are renderer evidence, not HTTP screenshots):

```sh
bun scripts/render-frames.ts .agents-frames/B35 --b35 100x30 180x50
```
