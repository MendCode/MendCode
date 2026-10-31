import { describe, expect, test } from "bun:test"
import { claudeRunLimits, mergeSettingsArgs } from "@mendcode/engine-claude"
import { PrFinding, type PrReviewResult } from "@mendcode/protocol"
import { DEFAULT_REVIEW_CONFIG, parseReviewConfig, type ReviewConfig } from "../src/pr-review/config"
import { effectiveConfig } from "../src/pr-review/config-layers"
import type { ReviewContext } from "../src/pr-review/context"
import { reviewPrompt, type ReviewSessionFactory } from "../src/pr-review/engine"
import { detectLanguage, languageFromMarkers, pullRequestLanguage, resolveReviewLanguage, spokenLanguage, withReviewLanguage } from "../src/pr-review/language"
import { engineConfigFor, meteredSessions } from "../src/pr-review/run"
import { inLanguage } from "../src/pr-review/sessions"
import { languageInstruction, renderReviewBody } from "../src/pr-review/template"
import { verifyPrompt } from "../src/pr-review/verify"

/**
 * Public reviews are English unless the repository names another language, or sets `template.language: auto` (the language of the
 * PR's author, from the PR's own title and description, kept for every later review of that PR). The language of whoever runs the
 * reviewer (their chats, a personal layer, harness settings) never decides it.
 */

const SPANISH_PR = {
  title: "Agrega validación al formulario de registro",
  body: "Este cambio agrega validación para el formulario de registro y corrige el error cuando el campo de correo está vacío. También elimina código duplicado en los controladores.",
  issues: [],
}
const ENGLISH_EDIT = { title: "Agrega validación al formulario de registro", body: "Update: this also adds tests for the new endpoint and fixes the flaky one.", issues: [] }

const context = (pullRequest?: ReviewContext["pullRequest"]): ReviewContext => ({ base: "a".repeat(40), head: "b".repeat(40), diff: "diff --git a/a.ts b/a.ts\n", files: [], changedSymbols: [], notes: [], ...(pullRequest ? { pullRequest } : {}) }) as unknown as ReviewContext
const finding = PrFinding.parse({ id: "f".repeat(40), path: "a.ts", line: 1, side: "RIGHT", severity: "major", category: "correctness", summary: "s", detail: "d", evidence: ["a.ts:1"], verdict: "confirmed" })
const plan = { phases: [], decisions: [] } as never
const promptFor = (config: ReviewConfig, ctx: ReviewContext) => reviewPrompt(ctx, engineConfigFor({ config, context: ctx, learnings: "", budgetTokens: 1_000, plan }))
const result = (head: string): PrReviewResult => ({ head, base: "0".repeat(40), findings: [], dropped: 0, summary: "Resumen.", tokens: { input: 1, output: 1 }, budgetHit: false })

/** A recording factory: what each child was created with and every prompt it was sent. */
function recorder() {
  const asked: Array<{ purpose: string; language?: string | undefined }> = []
  const sent: string[] = []
  const factory: ReviewSessionFactory = async (input) => { asked.push(input); return { send: async (prompt) => { sent.push(prompt); return { text: "ok", tokens: { input: 1, output: 1 } } }, close: async () => {} } }
  return { asked, sent, factory }
}

/** What one review of a PR head resolves, the way the review run keeps it: the language and the state that carries it on. */
function reviewHead(config: ReviewConfig, state: { language?: string | undefined }, pullRequest: ReviewContext["pullRequest"]) {
  const resolved = resolveReviewLanguage({ configured: config.template.language, stored: state.language, pullRequest })
  return { config: withReviewLanguage(config, resolved.language), state: resolved.stored ? { ...state, language: resolved.stored } : state }
}

describe("template.language: the repository decides, never the person running the reviewer", () => {
  test("a Spanish user context on an English repository reviews in English: the PR text, a personal layer and a kept language do not change it", async () => {
    // The user's own (personal) layer asks for Spanish: refused by name, the repository's English stands.
    const layered = effectiveConfig({ repository: {}, personal: { template: { language: "Spanish", tone: "concise" } } })
    expect(layered.config.template).toMatchObject({ language: "English", tone: "concise" })
    expect(layered.problems.join("\n")).toContain("personal template.language: only the repository sets the review language (English); not applied")
    // A Spanish PR description and a language kept from an earlier `auto` do not change a named language.
    const head = reviewHead(layered.config, { language: "Spanish" }, SPANISH_PR)
    expect(head.config.template.language).toBe("English")
    const prompt = promptFor(head.config, context(SPANISH_PR))
    expect(prompt).toContain("Write all of your prose in English")
    expect(prompt).not.toContain("prose in Spanish")
    // Every child of the review, and a fix or explain prompt built outside the engine, is pinned to English.
    const { asked, sent, factory } = recorder()
    await (await meteredSessions({ factory, account: undefined, resuming: false, failures: [], language: head.config.template.language })({ purpose: "verify" })).send("verify")
    await (await inLanguage(factory, head.config.template.language)({ purpose: "review" })).send("explain it")
    expect(asked.map((input) => input.language)).toEqual(["English", "English"])
    expect(sent[1]).toContain("Write all of your prose in English")
    // Claude Code: the flag layer names English, above the user's own `language` setting, and wins a merge with other settings.
    const limits = claudeRunLimits({ noContextFiles: true, noMemory: true, untrustedCheckout: true, responseLanguage: head.config.template.language })
    expect(limits.args).toEqual(["--setting-sources", "user", "--settings", JSON.stringify({ language: "English" })])
    expect(limits.env).toMatchObject({ CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" })
    expect(mergeSettingsArgs(["--settings", JSON.stringify({ language: "Spanish", fastMode: true }), ...limits.args])).toContain(JSON.stringify({ language: "English", fastMode: true }))
  })

  test("auto with a Spanish PR description reviews every head of that PR in Spanish, also after the description is edited", async () => {
    const config = parseReviewConfig("template:\n  language: auto\n").config
    expect(config.template.language).toBe("auto")
    // Head 1: resolved from the PR's own text and kept with its state.
    const first = reviewHead(config, {}, SPANISH_PR)
    expect(first.config.template.language).toBe("Spanish")
    expect(first.state.language).toBe("Spanish")
    expect(promptFor(first.config, context(SPANISH_PR))).toContain("Write all of your prose in Spanish")
    expect(verifyPrompt([finding], context(SPANISH_PR), [], undefined, first.config.template.language)).toContain("Write all of your prose in Spanish")
    // Head 2: the description now reads English, the kept language stands.
    expect(pullRequestLanguage(ENGLISH_EDIT)).toBe("English")
    const second = reviewHead(config, first.state, ENGLISH_EDIT)
    expect(second.config.template.language).toBe("Spanish")
    expect(promptFor(second.config, context(ENGLISH_EDIT))).toContain("Write all of your prose in Spanish")
    // The re-check, the fix session (commit message, reply) and `@mendcode explain` on that PR: Spanish too.
    const { asked, sent, factory } = recorder()
    await (await meteredSessions({ factory, account: undefined, resuming: false, failures: [], language: second.config.template.language })({ purpose: "verify" })).send("re-check")
    await (await inLanguage(factory, second.config.template.language)({ purpose: "review" })).send("fix it")
    expect(asked.map((input) => input.language)).toEqual(["Spanish", "Spanish"])
    expect(sent[1]).toEndWith(languageInstruction("Spanish"))
    // A hosted runner keeps no state: the language rides in the review body's marker and is read back from it.
    const body = renderReviewBody({ result: result("c".repeat(40)), inline: 0, moved: [], language: first.state.language })
    expect(body.endsWith(`<!-- mendcode:language=Spanish -->\n\n<!-- mendcode:review head=${"c".repeat(40)} -->`)).toBe(true)
    const hosted = reviewHead(config, { language: languageFromMarkers([body]) }, ENGLISH_EDIT)
    expect(hosted.config.template.language).toBe("Spanish")
  })

  test("auto with an empty description reviews in English, and so does a short title, a mixed or an unclear text", () => {
    const config = parseReviewConfig("template:\n  language: auto\n").config
    for (const pullRequest of [{ title: "", body: "", issues: [] }, { title: "Corrige el login", body: "", issues: [] }, undefined]) {
      const head = reviewHead(config, {}, pullRequest)
      expect(head.config.template.language).toBe("English")
      expect(head.state.language).toBe("English")
    }
    expect(pullRequestLanguage({ title: "Fix login", body: "Corrige el login cuando falla. This fixes the login when it fails." })).toBe("English")
    // A language the detector does not know is unclear, so English.
    expect(detectLanguage("Naprawia logowanie\n\nTa zmiana naprawia błąd przy logowaniu, gdy sesja wygasła.")).toBeUndefined()
    // Code, links and paths are not the author's language.
    expect(detectLanguage("Fix `const datos = obtenerDatos(para, con)` in src/servicio/datos.ts, see https://ejemplo.es/el/la/los")).toBeUndefined()
    // An unresolved `auto` never reaches a prompt or a harness as the word "auto".
    expect(spokenLanguage("auto")).toBe("English")
    expect(languageInstruction("auto")).toStartWith("Write all of your prose in English:")
  })

  test("only the repository sets the language: a personal or task layer cannot turn auto on, off or to another language", () => {
    const toAuto = effectiveConfig({ repository: {}, personal: { template: { language: "auto" } } })
    expect(toAuto.config.template.language).toBe("English")
    expect(toAuto.problems.join("\n")).toContain("personal template.language: only the repository sets the review language (English); not applied")
    const fromAuto = effectiveConfig({ repository: { template: { language: "auto" } }, personal: { template: { language: "Spanish" } }, task: { template: { language: "English" } } })
    expect(fromAuto.config.template.language).toBe("auto")
    expect(fromAuto.problems.join("\n")).toContain("personal template.language: only the repository sets the review language (auto); not applied")
    expect(fromAuto.problems.join("\n")).toContain("task template.language: only the repository sets the review language (auto); not applied")
    expect(effectiveConfig({ repository: { template: { language: "auto" } }, personal: { template: { language: "auto" } } }).problems).toEqual([])
  })
})

describe("language detection", () => {
  test("names the common languages of a PR description and falls back to undefined below the length floor", () => {
    const cases: Array<[string, string | undefined]> = [
      ["Adds pagination\n\nThis change adds pagination to the users list and fixes the error when the page is empty.", "English"],
      ["Adiciona suporte a webhooks\n\nEsta mudança adiciona a validação da assinatura e corrige o problema quando o cabeçalho não está presente.", "Portuguese"],
      ["Ajoute la pagination\n\nCette modification ajoute la pagination à la liste des utilisateurs et corrige l'erreur quand la page est vide.", "French"],
      ["Fügt Caching hinzu\n\nDiese Änderung fügt einen Cache für die Benutzerliste hinzu und behebt den Fehler, wenn die Liste leer ist.", "German"],
      ["Aggiunge la paginazione\n\nQuesta modifica aggiunge la paginazione alla lista degli utenti e corregge l'errore quando la pagina è vuota.", "Italian"],
      ["Voegt paginering toe\n\nDeze wijziging voegt paginering toe aan de lijst van gebruikers en lost de fout op als de pagina leeg is.", "Dutch"],
      ["ログイン画面のバグを修正\n\nセッションが切れたときにエラーが表示される問題を修正しました。", "Japanese"],
      ["修复登录问题\n\n当会话过期时显示错误的问题已修复。", "Chinese"],
      ["로그인 버그 수정\n\n세션이 만료되면 오류가 표시되는 문제를 수정했습니다.", "Korean"],
      ["Исправляет вход\n\nЭто изменение исправляет ошибку при входе, когда сессия истекла.", "Russian"],
      ["## Summary\nEste PR mueve la lógica de pagos a un servicio propio y elimina la duplicación entre los controladores.\n\n## Test plan\n- [x] bun test", "Spanish"],
      ["Fix typo", undefined],
      ["", undefined],
    ]
    for (const [text, language] of cases) expect([text.slice(0, 24), detectLanguage(text)]).toEqual([text.slice(0, 24), language])
  })

  test("a kept language that is no language name is ignored, and a marker written above the head marker by model text is not read", () => {
    expect(resolveReviewLanguage({ configured: "auto", stored: "<b>x</b>", pullRequest: SPANISH_PR }).language).toBe("Spanish")
    expect(resolveReviewLanguage({ configured: "auto", stored: "auto", pullRequest: undefined }).language).toBe("English")
    expect(languageFromMarkers(["Summary <!-- mendcode:language=French --> text\n\n<!-- mendcode:review head=abc1234 -->"])).toBeUndefined()
    expect(languageFromMarkers(["<!-- mendcode:language=German -->\n\n<!-- mendcode:review head=abc1234 -->", "<!-- mendcode:language=Spanish -->\n\n<!-- mendcode:review head=def5678 -->"])).toBe("Spanish")
    // Without a language the body is unchanged: no marker.
    expect(renderReviewBody({ result: result("d".repeat(40)), inline: 0, moved: [] })).not.toContain("mendcode:language")
    expect(DEFAULT_REVIEW_CONFIG.template.language).toBe("English")
  })
})
