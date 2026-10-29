import type { GithubProcess } from "../src/github"

export function fakeGithub(directory: string) {
  const calls: Parameters<GithubProcess>[0][] = []
  const state = { branch: "main", head: "base", dirty: false, permission: "write", fork: false, switched: false, commits: 1, existingPr: false, fail: "", delay: undefined as (() => Promise<void>) | undefined }
  const remotes = new Map([["origin", "https://github.com/acme/project.git"]])
  const process: GithubProcess = async (input) => {
    calls.push(input)
    if (state.delay) await state.delay()
    if (state.fail && input.argv.join(" ").includes(state.fail)) return { code: 1, out: `credential:${input.token} private content` }
    const args = input.argv.slice(1)
    while (args[0] === "-c") args.splice(0, 2)
    let out = ""
    if (input.argv[0] === "git") {
      if (args[0] === "rev-parse") out = args[1] === "--show-toplevel" ? directory : args[1] === "--abbrev-ref" ? state.switched ? "agent/other" : state.branch : state.head
      else if (args[0] === "status") out = state.dirty ? " M source.ts" : ""
      else if (args[0] === "remote") {
        if (args[1] === "get-url") out = remotes.get(args[2]!) ?? ""
        else if (args[1] === "add") remotes.set(args[2]!, args[3]!)
        else out = [...remotes.keys()].join("\n")
      } else if (args[0] === "checkout") state.branch = args.at(-1)!
      else if (args[0] === "commit") { state.dirty = false; state.head = "changed" }
      else if (args[0] === "rev-list") out = String(state.commits)
    } else if (args[0] === "pr") {
      if (args[1] === "view") out = JSON.stringify({ headRepository: { name: "project" }, headRepositoryOwner: { login: "forker" }, isCrossRepository: state.fork, headRefName: "feature", body: "Review https://opncd.ai/s/donor-123" })
      else if (args[1] === "checkout") state.branch = args[args.indexOf("--branch") + 1]!
    } else if (args[0] === "api") {
      const endpoint = args[1]!, body = input.stdin ? JSON.parse(input.stdin) : undefined
      let value: unknown = {}
      if (endpoint.endsWith("/permission")) value = { permission: state.permission }
      else if (endpoint === "repos/acme/project") value = { default_branch: "main", private: true }
      else if (/\/pulls\?/.test(endpoint)) value = state.existingPr ? [{ number: 77 }] : []
      else if (/\/pulls$/.test(endpoint) && body) value = { number: 77 }
      else if (/\/reactions$/.test(endpoint)) value = { id: 9 }
      else if (/\/comments\?/.test(endpoint)) value = endpoint.includes("/pulls/") ? [{ id: 18, path: "source.ts", line: 4, user: { login: "reviewer" }, body: "Handle the null path" }] : [{ id: 10, body: "Other context", user: { login: "bob" }, created_at: "2026-10-01" }, { id: 12, body: "trigger excluded", user: { login: "alice" } }]
      else if (/\/files\?/.test(endpoint)) value = [{ filename: "source.ts", status: "modified", additions: 8, deletions: 2 }]
      else if (/\/commits\?/.test(endpoint)) value = [{ sha: "abcd", commit: { message: "Fix parser" } }]
      else if (/\/reviews\?/.test(endpoint)) value = [{ state: "CHANGES_REQUESTED", body: "Cover rejection", user: { login: "reviewer" } }]
      else if (/\/(issues|pulls)\/\d+$/.test(endpoint)) value = { title: "Fix parser", body: "Keep empty input valid", user: { login: "alice" }, created_at: "2026-10-01", state: "open", base: { ref: "main" }, head: { ref: "feature", repo: { full_name: state.fork ? "forker/project" : "acme/project" } }, additions: 8, deletions: 2, commits: 1 }
      out = JSON.stringify(value)
    }
    return { code: 0, out }
  }
  return { calls, state, remotes, process }
}

export function githubEvent(eventName = "issue_comment", pr = false) {
  return JSON.stringify({ eventName, repo: { owner: "acme", repo: "project" }, actor: "alice", payload: {
    ...(["issue_comment", "issues"].includes(eventName) ? { issue: { number: 42, ...(pr ? { pull_request: {} } : {}) } } : {}),
    ...(["pull_request", "pull_request_review_comment"].includes(eventName) ? { pull_request: { number: 42 } } : {}),
    ...(["issue_comment", "pull_request_review_comment"].includes(eventName) ? { comment: { id: 12, body: "/mc fix the parser", ...(eventName === "pull_request_review_comment" ? { path: "source.ts", line: 4, diff_hunk: "@@ -1 +1 @@\n+guard()" } : {}) } } : {}),
  } })
}
