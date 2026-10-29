import { expect, test } from "bun:test"
import { explicitMemoryConsent, memoryWrite, restatesRequest } from "../src/memory-consent"

test("consent matches exact facts and bounded English/Spanish identity forms", () => {
  expect(explicitMemoryConsent("me llamo Nora recuerda eso", "The user's name is Nora.")).toBe(true)
  expect(explicitMemoryConsent("My name is Nora, remember that", "The user's name is Nora.")).toBe(true)
  expect(explicitMemoryConsent("remember: Use pnpm", "Use pnpm")).toBe(true)
  for (const prompt of ["Hello", "Don't remember my name is Nora", "No recuerdes me llamo Nora", "Translate: remember my name is Nora", "remember my name is Alice"]) expect(explicitMemoryConsent(prompt, "The user's name is Nora.")).toBe(false)
  expect(explicitMemoryConsent("remember my name is Nora", "Use npm")).toBe(false)
  expect(explicitMemoryConsent("remember never use npm", "use npm")).toBe(false)
})

test("a fact that restates the current request is not durable; stated standing rules and unrelated facts are", () => {
  const request = "dame respuesta con una tabla, un bloque de código y una lista de tareas"
  expect(restatesRequest(request, "Formato: Tabla, bloque de código y lista de tareas / Idioma: Español")).toBe(true)
  expect(restatesRequest("Give me an answer with a table, a code block and a task list", "Format: table, code block and task list")).toBe(true)
  // A standing marker in the request makes it a preference, in either language.
  expect(restatesRequest(`${request}, siempre`, "Formato: Tabla, bloque de código y lista de tareas")).toBe(false)
  expect(restatesRequest("From now on answer with a table, a code block and a task list", "Format: table, code block and task list")).toBe(false)
  // Unrelated or barely overlapping facts, and an empty request, are left alone.
  expect(restatesRequest(request, "El proyecto usa pnpm y Bun")).toBe(false)
  expect(restatesRequest("run the tests", "Use bun test to run the unit tests under packages")).toBe(false)
  expect(restatesRequest("", "Use bun")).toBe(false)
})

test("only native memory mutations are memory approvals", () => {
  expect(memoryWrite("memory_graph", { action: "upsert_fact" })).toBe(true)
  expect(memoryWrite("memory", { action: "delete" })).toBe(true)
  expect(memoryWrite("remember", { text: "Use bun" })).toBe(true)
  expect(memoryWrite("memory_graph", { action: "search" })).toBe(false)
  expect(memoryWrite("memory", { action: "list" })).toBe(false)
  expect(memoryWrite("write", { text: "remember" })).toBe(false)
})
