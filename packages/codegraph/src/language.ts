import { extname } from "node:path"
import { EXTENSION_LANGUAGE, type Language } from "./types"

export const languageOf = (path: string): Language | undefined => EXTENSION_LANGUAGE[extname(path).toLowerCase()]
