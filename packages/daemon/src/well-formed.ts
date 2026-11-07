/** Replaces a lone surrogate half (a cut through a pair) with U+FFFD: a lone half is invalid in a JSON request body and the provider answers 400. */
export const wellFormed = (text: string) => text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�")
