Use the file/find REST routes to search and read a registered project's files and symbols. The existing [HTTP adapter](remote.md#http-adapter-b34) is off by default, loopback-only and token-authenticated.

All six routes require a full token, including reads: source text, images, names and symbols are private project data. `file.rest.read` is excluded from `READ_ONLY_COMMANDS`.

## File/find REST adapter (B35)

Select an existing registered project using `directory`/`x-opencode-directory` or `workspace`/`x-mendcode-workspace`. Unknown or conflicting selectors return 403; select a registered project.

### Routes

| GET route | Query | Response / operation ID |
|---|---|---|
| `/find` | `pattern` (regex) | ripgrep JSON matches: `path.text`, `lines.text`, 1-based `line_number`, byte `absolute_offset`, byte `submatches` / `find.text` |
| `/find/file` | `query`, `dirs=true\|false`, `type=file\|directory`, `limit=1…200` (default 10) | Fuzzy-ranked paths, directories ending in `/` / `find.files` |
| `/find/symbol` | `query` | `{name, kind, location: {uri, range}}[]`, 0-based LSP positions / `find.symbols` |
| `/file` | `path` (empty for root) | Directory-first `{name, path, absolute, type, ignored}[]` / `file.list` |
| `/file/content` | `path` | `{type: text\|binary, content, diff?, patch?, encoding?, mimeType?}` / `file.read` |
| `/file/status` | — | `{path, added, removed, status: added\|deleted\|modified}[]` / `file.status` |

All queries require their named fields; empty text/name/symbol queries and root paths are accepted. Unknown or repeated query parameters are rejected.

OpenAPI includes the donor operation IDs, response schemas and query bounds. Native clients use `client.filesApi(directory, input)` with one of the six operation IDs and receive typed `{ok, value}` results.

### Search text and paths

Text search uses installed ripgrep with hidden files, project ignore rules, no user rg configuration and no symlink following. As in v1, it returns ten matching lines **per file**.

File search uses the same project inventory:

| Query or condition | Behavior |
|---|---|
| Empty queries | Default to directories |
| `dirs=false` or `type=file` | Request files |
| Explicit type | Wins over dirs |
| Hidden directories | Sort last unless explicitly searched |

Successful content reads persist bounded frequency/last-open metadata under `<data dir>/file-frecency.json`. Empty file queries and fuzzy matches prioritize recent frequent opens with v1's daily decay.

### List and read files

Listings omit `.git`, `.DS_Store`, external symlinks and non-regular files. Git owns `.gitignore` matching, including nested rules; root `.ignore` rules apply afterward.

Content reads deny traversal and external symlinks, including absent descendants of symlinked directories.

| Content | Returned form |
|---|---|
| Missing files | `{type: text, content: ""}` |
| Text | Trimmed as in v1 |
| Images | Base64 with MIME type |
| Binary files | Empty binary content |

Changed text includes a full-context structured patch from HEAD to the returned text. It includes staged changes, whitespace-insensitive line matching and EOF markers. Neither Git diff drivers nor textconv run.

### Read file status

Status compares the selected directory to HEAD. It includes staged and unstaged changes plus untracked files, preserves NUL-delimited filenames and handles unborn repositories.

- Deleted files have one `deleted` row with zero counts; v1's duplicated modified/deleted entries are normalized.
- Non-Git projects return `[]`.
- No index refresh, fetch or project-file write occurs.

### Find symbols

Connect servers with the existing [LSP](lsp.md) tool to enable useful results. Symbol discovery queries only live LSP servers rooted inside the selected project: ten relevant symbols per server, filtered to valid in-project file URIs.

It never starts a server or provisions a binary. A cold/unconfigured project returns `[]`, matching v1's current empty HTTP handler. Server failures are explicit if no server succeeds.

### Limits

| Operation or resource | Limit |
|---|---|
| Request operation deadline | Five seconds |
| File reads | 120,000 bytes |
| Inventories | 50,000 paths |
| Listings/status | 2,000 entries |
| Subprocess stdout | 8 MiB |
| Subprocess stderr | 16 KiB |
| JSON responses | Existing 256 KiB frame |
| Line diffs | Bounded work budget |

Limits return 400 rather than silently truncating a donor payload. Missing ripgrep returns 501; it is never downloaded.

## Terminal viewer (`file.view`)

The terminal's [file viewer](file-viewer.md) uses the native read-only command `file.view`. Read-only peers may send it.

It does not use `/file/content`: that read fails above 120,000 bytes, trims content and has no redaction or windowing.

`file.view` provides:

- A bounded window of lines.
- Containment and symlink checks like the routes above.
- Masked secrets.
- `stat` before opening, so devices and pipes are never read.

## Browser editor (`file.edit`)

The six routes above are read-only and trimmed. For exact text and saving in the [web client](remote.md)'s Files pane, use the native command `file.edit` through `/command` or `client.fileEdit(directory, input)`.

### Enable editing

Editing is **off by default**. Enable it with `serve/web --edit` or `{"server":{"edit":true}}` in `remote.json`; otherwise it returns 501 and the pane is a read-only viewer.

It needs a full token and is not in `READ_ONLY_COMMANDS`.

### Read and save exact text

| Input | Result |
|---|---|
| `{operation: "read", path}` | `{path, content, sha256, bytes}`: exact UTF-8 text, no trimming; a missing file is `content: ""`, `sha256: null` |
| `{operation: "write", path, content, expected}` | `{path, sha256, bytes}`; `expected` must equal the file's current sha256 (`null` to create), so an agent or another tab changing the file makes the save fail with "File changed on disk" instead of overwriting |

Paths follow the file API rules: inside the selected project, no external symlinks, and traversal is 403. `.git` is never readable or writable here.

- Files must be valid UTF-8 without NUL and at most 120,000 bytes.
- Directories are not created; a missing parent is 400.

A write goes to a temp file in the same directory and is renamed over the target, keeping the file mode.

**Warning:** Edits are made as the token's user and bypass agent approvals, like any other client action. This is why the opt-in exists.

## Implementation and renderer evidence

There are no new dependencies, downloads or terminal screens. B35 adds no UI. Local fake-server tests require no external service.

The existing conversation renderer is exercised with local API fixtures. These are renderer evidence, not HTTP screenshots:

```sh
bun scripts/render-frames.ts .agents-frames/B35 --b35 100x30 180x50
```
