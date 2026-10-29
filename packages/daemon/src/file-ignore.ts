/** Directory patterns exclude their descendants as well as the directory entry. */
export function fileIgnore(patterns: string[] = []) {
  const globs = patterns.map((pattern) => new Bun.Glob(pattern))
  return (file: string) => {
    if (!globs.length) return false
    const parts = file.replace(/^\.\//, "").split("/")
    return parts.some((part, index) => globs.some((glob) => glob.match(part) || glob.match(parts.slice(0, index + 1).join("/")) || glob.match(parts.slice(0, index + 1).join("/") + "/")))
  }
}
