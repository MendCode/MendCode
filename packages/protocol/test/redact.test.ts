import { describe, expect, test } from "bun:test"
import { redactEventText as redactFromIndex } from "../src"
import { redactEventText, redactSecrets } from "../src/wire"
import { budgetMs } from "../../../scripts/test-budget"

const alnum = (length: number) => "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0".repeat(Math.ceil(length / 30)).slice(0, length)

const secrets = {
  openai: "s" + "k-" + alnum(48),
  anthropic: "s" + "k-ant-" + "api03-" + alnum(60),
  project: "s" + "k-proj-" + alnum(40) + "_" + alnum(20),
  ghp: "gh" + "p_" + "a".repeat(36),
  gho: "gh" + "o_" + "b".repeat(36),
  ghu: "gh" + "u_" + "c".repeat(36),
  ghs: "gh" + "s_" + "d".repeat(36),
  ghr: "gh" + "r_" + "e".repeat(36),
  githubPat: "github" + "_pat_" + alnum(40),
  awsAccess: "AK" + "IA" + "ABCDEFGHIJKLMNOP",
  awsTemporary: "AS" + "IA" + "ABCDEFGHIJKLMNOP",
  awsSecret: alnum(40),
  slack: "xo" + "xb-" + "1234567890-" + alnum(24),
  google: "AI" + "za" + alnum(35),
  stripeSecret: "s" + "k_live_" + alnum(24),
  stripeRestricted: "r" + "k_live_" + alnum(24),
  jwt: "ey" + "J" + alnum(20) + "." + "ey" + "J" + alnum(30) + "." + alnum(43),
  bearer: alnum(32),
}

describe("redactSecrets kinds", () => {
  test.each([
    ["an OpenAI key", secrets.openai, "openai-key"],
    ["an Anthropic key", secrets.anthropic, "anthropic-key"],
    ["an OpenAI project key", secrets.project, "openai-key"],
    ["a GitHub personal token", secrets.ghp, "github-token"],
    ["a GitHub oauth token", secrets.gho, "github-token"],
    ["a GitHub user token", secrets.ghu, "github-token"],
    ["a GitHub server token", secrets.ghs, "github-token"],
    ["a GitHub refresh token", secrets.ghr, "github-token"],
    ["a GitHub fine-grained token", secrets.githubPat, "github-token"],
    ["an AWS access key id", secrets.awsAccess, "aws-access-key-id"],
    ["an AWS temporary access key id", secrets.awsTemporary, "aws-access-key-id"],
    ["a Slack token", secrets.slack, "slack-token"],
    ["a Google API key", secrets.google, "google-api-key"],
    ["a Stripe secret key", secrets.stripeSecret, "stripe-key"],
    ["a Stripe restricted key", secrets.stripeRestricted, "stripe-key"],
    ["a JWT", secrets.jwt, "jwt"],
  ])("redacts %s", (_name, secret, kind) => {
    const result = redactSecrets(`before ${secret} after`)
    expect(result.text).toBe(`before [redacted:${kind}] after`)
    expect(result.count).toBe(1)
  })

  test("redacts an AWS secret access key assignment and keeps the name", () => {
    const result = redactSecrets(`aws_secret_access_key = ${secrets.awsSecret}`)
    expect(result.text).toBe("aws_secret_access_key = [redacted:aws-secret]")
    expect(result.count).toBe(1)
  })

  test("redacts an Authorization bearer token and keeps the header", () => {
    const result = redactSecrets(`curl -H "Authorization: Bearer ${secrets.bearer}" https://api.example.com`)
    expect(result.text).toBe('curl -H "Authorization: Bearer [redacted:bearer-token]" https://api.example.com')
    expect(result.count).toBe(1)
  })

  test("redacts a basic Authorization header payload", () => {
    const result = redactSecrets("Authorization: Basic dXNlcjpwYXNzd29yZDEyMw==")
    expect(result.text).toBe("Authorization: Basic [redacted:basic-auth]")
  })

  test("redacts a whole PEM private key block across lines", () => {
    const block = ["-----BEGIN " + "RSA PRIVATE KEY-----", alnum(64), alnum(64), "-----END " + "RSA PRIVATE KEY-----"].join("\n")
    const result = redactSecrets(`key:\n${block}\nend`)
    expect(result.text).toBe("key:\n[redacted:private-key]\nend")
    expect(result.count).toBe(1)
  })

  test("redacts OpenSSH and unprefixed private key blocks", () => {
    for (const label of ["OPENSSH PRIVATE KEY", "PRIVATE KEY", "ENCRYPTED PRIVATE KEY"]) {
      const block = `-----BEGIN ${label}-----\n${alnum(70)}\n-----END ${label}-----`
      expect(redactSecrets(block).text).toBe("[redacted:private-key]")
    }
  })

  test("keeps the user and redacts only the password of a credentialed URL", () => {
    const result = redactSecrets("postgres://admin:" + alnum(16) + "@db.internal:5432/app")
    expect(result.text).toBe("postgres://admin:[redacted:url-password]@db.internal:5432/app")
    expect(result.count).toBe(1)
  })
})

describe("redactSecrets assignments", () => {
  const value = "hunter2hunter2"

  test.each([
    ["an env line", `API_KEY=${value}`, "API_KEY=[redacted:api-key]"],
    ["an exported env line", `export DB_PASSWORD=${value}`, "export DB_PASSWORD=[redacted:password]"],
    ["a quoted env value", `SECRET_TOKEN="${value}"`, `SECRET_TOKEN="[redacted:token]"`],
    ["a single quoted env value", `CLIENT_SECRET='${value}'`, `CLIENT_SECRET='[redacted:secret]'`],
    ["a yaml line", `password: ${value}`, "password: [redacted:password]"],
    ["a json pair", `{"accessToken": "${value}", "ok": true}`, `{"accessToken": "[redacted:token]", "ok": true}`],
    ["an escaped json pair inside a string", String.raw`{"text":"{\"apiKey\":\"${value}\"}"}`, String.raw`{"text":"{\"apiKey\":\"[redacted:api-key]\"}"}`],
    ["a spaced assignment", `PRIVATE_KEY = ${value}`, "PRIVATE_KEY = [redacted:private-key]"],
    ["a header line", `x-api-key: ${value}`, "x-api-key: [redacted:api-key]"],
    ["an access key line", `AWS_ACCESS_KEY=${value}`, "AWS_ACCESS_KEY=[redacted:access-key]"],
    ["a query parameter", `https://x.test/cb?token=${value}&next=1`, "https://x.test/cb?token=[redacted:token]&next=1"],
    ["a passwd line", `PASSWD=${value}`, "PASSWD=[redacted:password]"],
  ])("redacts %s and keeps the name", (_name, input, expected) => {
    const result = redactSecrets(input)
    expect(result.text).toBe(expected)
    expect(result.count).toBe(1)
  })

  test("redacts several assignments in one multi-line block", () => {
    const result = redactSecrets(`A_TOKEN=${value}\nPLAIN=visible-value\nB_SECRET=${value}`)
    expect(result.text).toBe("A_TOKEN=[redacted:token]\nPLAIN=visible-value\nB_SECRET=[redacted:secret]")
    expect(result.count).toBe(2)
  })

  test("counts a known token once when it sits inside an assignment", () => {
    const result = redactSecrets(`OPENAI_API_KEY=${secrets.openai}`)
    expect(result.text).toBe("OPENAI_API_KEY=[redacted:openai-key]")
    expect(result.count).toBe(1)
  })
})

describe("redactSecrets false positives", () => {
  const untouched = [
    ["a git sha", "commit 9fceb02d0ae598e95dc970b74767f19372d61af8 on main"],
    ["a uuid", "request 123e4567-e89b-12d3-a456-426614174000 done"],
    ["a sha256 hex digest", "sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["a session ulid id", "session ses_01M3ZQ8X4V7N2K9D5R6T1B0HCY resumed"],
    ["a memory ulid id", "memory_01M3ZQ8X4V7N2K9D5R6T1B0HCY saved"],
    ["a short password", "PASSWORD=short"],
    ["a short token", "token: abc123"],
    ["a your-api-key placeholder", "API_KEY=your-api-key"],
    ["an xxx placeholder", "API_KEY=xxxxxxxxxxxx"],
    ["a bracket placeholder", "TOKEN=<token>"],
    ["a brace variable", "TOKEN=${GITHUB_TOKEN}"],
    ["a dollar variable", "SECRET_KEY=$SECRET_KEY_VALUE"],
    ["a changeme placeholder", "DB_PASSWORD=changeme"],
    ["a quoted placeholder", `{"password": "<your-password>"}`],
    ["a credentialed url with a placeholder", "postgres://user:password@localhost:5432/app"],
    ["a url without credentials", "https://example.com:8080/path?x=1"],
    ["a ssh remote", "git@github.com:org/repo.git"],
    ["an env reference in code", "const apiKey = process.env.OPENAI_API_KEY"],
    ["a function call in code", "const token = getAuthorizationToken()"],
    ["a camel case identifier in code", "const apiKey = readConfiguredApiKey"],
    ["a token counter", "max_tokens: 100000000"],
    ["a plain prose line", "Token: expired yesterday, please sign in again"],
    ["a bearer prose mention", "use bearer authentication for the api"],
    ["a file path value", "API_KEY_FILE=/run/secrets/api_key"],
    ["an xxx key body", "s" + "k-" + "x".repeat(32)],
  ] as const

  test.each(untouched)("leaves %s untouched", (_name, input) => {
    expect(redactSecrets(input)).toEqual({ text: input, count: 0 })
  })
})

describe("redactSecrets properties", () => {
  const mixed = [
    `OPENAI_API_KEY=${secrets.openai}`,
    `token ${secrets.ghp}`,
    `Authorization: Bearer ${secrets.bearer}`,
    "postgres://admin:" + alnum(16) + "@db.internal/app",
    `{"password": "hunter2hunter2"}`,
    `-----BEGIN ${"PRIVATE KEY"}-----\n${alnum(64)}\n-----END ${"PRIVATE KEY"}-----`,
    secrets.jwt,
  ].join("\n")

  test("redacting twice yields the same text and a zero count the second time", () => {
    const first = redactSecrets(mixed)
    expect(first.count).toBe(7)
    const second = redactSecrets(first.text)
    expect(second).toEqual({ text: first.text, count: 0 })
  })

  test("text without secrets comes back identical with a zero count", () => {
    expect(redactSecrets("")).toEqual({ text: "", count: 0 })
    expect(redactSecrets("plain text only")).toEqual({ text: "plain text only", count: 0 })
  })

  test("a 60 KB input redacts in under 50 ms", () => {
    const line = `log line with id ses_01M3ZQ8X4V7N2K9D5R6T1B0HCY and sha 9fceb02d0ae598e95dc970b74767f19372d61af8\n`
    const body = line.repeat(Math.ceil(50_000 / line.length)).slice(0, 50_000)
    const input = `${body}\nAPI_KEY=${secrets.openai}\n${"a".repeat(10_000 - 100)}`
    expect(input.length).toBeGreaterThanOrEqual(59_000)
    const start = performance.now()
    const result = redactSecrets(input)
    const elapsed = performance.now() - start
    expect(result.count).toBe(1)
    expect(elapsed).toBeLessThan(budgetMs(50))
  })

  test("hostile 60 KB inputs do not backtrack catastrophically", () => {
    const inputs = [
      "a".repeat(60_000),
      "a-".repeat(30_000),
      "TOKEN=".repeat(10_000),
      "sk-" + "a".repeat(59_000),
      "eyJ" + "a".repeat(30_000) + "." + "b".repeat(30_000),
      "://".repeat(20_000),
      "Authorization: Bearer ".repeat(2_700),
      "-----BEGIN PRIVATE KEY-----\n".repeat(2_000),
    ]
    for (const input of inputs) {
      const start = performance.now()
      redactSecrets(input)
      // Catastrophic backtracking takes seconds; the worst bounded case ("TOKEN=" x10k) is ~170 ms alone and
      // roughly doubles under a loaded parallel run.
      expect(performance.now() - start).toBeLessThan(budgetMs(1_000))
    }
  })
})

describe("redactEventText", () => {
  test("redacts text, detail and title and leaves other fields alone", () => {
    const draft = {
      type: "note",
      text: `key ${secrets.ghp}`,
      detail: `API_KEY=${secrets.openai}`,
      title: `Bearer-less title ${secrets.google}`,
      payload: { text: `nested ${secrets.ghp}` },
      extra: secrets.ghp,
    }
    const result = redactEventText(draft)
    expect(result).not.toBe(draft)
    expect(result.text).toBe("key [redacted:github-token]")
    expect(result.detail).toBe("API_KEY=[redacted:openai-key]")
    expect(result.title).toBe("Bearer-less title [redacted:google-api-key]")
    expect(result.payload).toBe(draft.payload)
    expect(result.extra).toBe(secrets.ghp)
    expect(draft.text).toBe(`key ${secrets.ghp}`)
  })

  test("returns the same object when nothing needs redaction", () => {
    const draft = { type: "note", text: "nothing secret", detail: undefined, title: 5 }
    expect(redactEventText(draft)).toBe(draft)
  })

  test("returns the same object when the fields are absent", () => {
    const draft = { type: "note", other: secrets.ghp }
    expect(redactEventText(draft)).toBe(draft)
  })

  test("copies only when a field changed and keeps untouched string fields as they were", () => {
    const draft = { text: "clean", title: `t ${secrets.stripeSecret}` }
    const result = redactEventText(draft)
    expect(result).toEqual({ text: "clean", title: "t [redacted:stripe-key]" })
  })

  test("is exported from the package index as well as the wire entry", () => {
    expect(redactFromIndex).toBe(redactEventText)
  })
})
