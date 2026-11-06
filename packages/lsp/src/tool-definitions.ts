import { z } from "zod"
import { LspInput } from "../../protocol/src/lsp"

export const lspToolDefinitions = {
  lsp: {
    name: "lsp",
    description: "Semantic code navigation: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls. filePath and editor line/character (1-based) are required; query filters workspace symbols.",
    permission: "read",
    args: LspInput,
  },
  diagnostics: {
    name: "diagnostics",
    description: "Report compiler/type-checker problems for a file from its language server (TypeScript, Python, Go, Rust). Returns 'no problems' when clean.",
    permission: "read",
    args: z.object({ path: z.string().describe("File path, absolute or relative to the project root") }),
  },
} as const
