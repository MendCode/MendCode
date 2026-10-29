/** Reject unrecognized statements instead of quietly drawing a valid prefix of a broken diagram. */
const rules: Readonly<Record<string, RegExp>> = {
  classdiagram: /^(?:direction\s+(?:TB|BT|LR|RL)|class\s+\w|namespace\s+\w|[{}]|<<\w+>>|[+~#-]?[\w~()[\], :<>.*+?=-]+|[\w.-]+\s+(?:"[^"]*"\s+)?(?:<\|--|--\|>|\*--|--\*|o--|--o|<--|-->|<\.\.|\.\.>|\.\.\|>|<\|\.\.|\.\.|--))/, 
  statediagram: /^(?:direction\s+(?:TD|TB|BT|LR|RL)|state\s+|[{}]|--|note\s+|end\s+note|\[\*\]|[\w.-]+\s*(?:-->|:))/, 
  erdiagram: /^(?:direction\s+(?:TB|BT|LR|RL)|[\w.-]+\s*(?:\{|[|o}{]{1,2}(?:--|\.\.)[|o}{]{1,2})\s*[\w.-]*(?:\s*:\s*.+)?|}|[\w[\](),]+\s+[\w.-]+(?:\s+.*)?)$/,
  gantt: /^(?:title\s+|dateFormat\s+|axisFormat\s+|tickInterval\s+|todayMarker\s+|excludes\s+|inclusiveEndDates|section\s+|.+\s*:\s*.+)/,
  pie: /^(?:title\s+.+|"[^"\n]+"\s*:\s*(?:\d+(?:\.\d+)?|\.\d+)|[^":]+\s*:\s*\d+(?:\.\d+)?)$/,
  timeline: /^(?:title\s+|section\s+|.+?:.+|\s*:.+)/,
  journey: /^(?:title\s+.+|section\s+.+|.+?:\s*[1-5](?:\s*:\s*.+)?)$/,
  quadrantchart: /^(?:title\s+|[xy]-axis\s+|quadrant-[1-4]\s+|.+?:\s*\[[-+\d.]+\s*,\s*[-+\d.]+\])/, 
  requirementdiagram: /^(?:(?:requirement|functionalRequirement|performanceRequirement|interfaceRequirement|physicalRequirement|designConstraint|element)\s+[\w-]+\s*\{|}|(?:id|text|risk|verifymethod|type|docref):\s*.+|[\w-]+\s+(?:<-|-)\s*(?:contains|copies|derives|satisfies|verifies|refines|traces)\s*(?:->|-)\s+[\w-]+)$/i,
  gitgraph: /^(?:commit(?:\s+.*)?|branch\s+.+|(?:checkout|switch|merge)\s+.+)$/,
  c4: /^(?:(?:Person\w*|System\w*|Container\w*|Component\w*|Enterprise_Boundary|Boundary|Deployment_Node|Node(?:_L|_R)?|Rel\w*|BiRel|Update\w*|Lay\w*)\s*\(.*\)\s*\{?|}|title\s+.+)$/i,
  xychart: /^(?:title\s+|[xy]-axis\s+|(?:bar|line)\s+\[[-+\d.,\s]+\])/, 
  sankey: /^(?:"[^"]*"|[^,]+),(?:"[^"]*"|[^,]+),\s*\d+(?:\.\d+)?$/,
  block: /^(?:columns\s+\d+|end|space(?::\d+)?|block:|[{}]|[\w.-]+(?:\s|\[|\(|\{|:|@|--|<--|$))/, 
  packet: /^\+?\d+(?:-\d+)?\s*:\s*"?[^"%]+"?(?:\s*%%.*)?$/,
  architecture: /^(?:(?:service|group|junction)\s+[\w-]+|[\w-]+(?:\{[^}]+\})?(?::[A-Z])?\s*(?:<-->|<--|-->|---|--|<->))/i,
  radar: /^(?:title\s+|min\s+|max\s+|showLegend\b|graticule\b|ticks\b|axis\s+|curve\s+)/,
  treemap: /^(?:"[^"\n]+"(?:\s*:\s*\d+(?:\.\d+)?)?|[\w .-]+(?:\s*:\s*\d+(?:\.\d+)?)?)$/,
  kanban: /^(?:\[[^\]]+\]|[\w-]+\[[^\]]+\])(?:\s*@\{[^}]+\})?$/,
  wardley: /^(?:title\s+|anchor\s+|component\s+|evolve\s+|note\s+|[\w .-]+\s*->\s*[\w .-]+)/,
  venn: /^(?:title\s+|(?:set|union|text)\s+)/,
  cynefin: /^(?:title\s+|complex|complicated|clear|chaotic|confusion|"[^"\n]+")/,
  eventmodeling: /^(?:(?:tf|timeframe|rf|resetframe|data)\s+|\S+\s*(?:->>|-->|->)\s*\S+|[{}]|"[^"\n]+"\s*:)/,
}

export function validStatements(header: string, body: string[]): boolean {
  let key = header.split(/\s/)[0]!.toLowerCase().replace(/-beta$/, "")
  if (key.startsWith("c4")) key = "c4"
  if (key === "statediagram-v2") key = "statediagram"
  if (key === "classdiagram-v2") key = "classdiagram"
  const rule = rules[key]
  let braces = 0
  let note = false
  for (const raw of body) {
    const line = raw.trim()
    if (key === "statediagram" && note) {
      if (/^end note$/i.test(line)) note = false
      continue
    }
    if (key === "statediagram" && /^note\s+(?:left|right)\s+of\s+[\w.-]+$/i.test(line)) note = true
    if (/^(?:accTitle|accDescr|classDef|style|click|linkStyle|class)\b/.test(line) && !/^class\s+\w+(?:\s*\{|\s*$)/.test(line)) continue
    if (!line || line.startsWith("%%")) continue
    if (rule && !rule.test(line) && !(key === "erdiagram" && braces > 0 && /^[\w[\](),]+\s+[\p{L}\p{N}_.-]+(?:\s+.*)?$/u.test(line))) return false
    if (["classdiagram", "statediagram", "erdiagram", "requirementdiagram"].includes(key)) {
      if (line === "}" && --braces < 0) return false
      if (/\s\{$/.test(line)) braces++
    }
    if (key === "packet") {
      const range = /^\+?(\d+)(?:-(\d+))?/.exec(line)
      if (range && (Number(range[1]) > 4096 || Number(range[2] ?? 0) > 4096 || (range[2] && Number(range[2]) < Number(range[1])))) return false
    }
    if (key === "block" && /^columns/.test(line) && Number(line.split(/\s+/)[1]) > 12) return false
    if (key === "gantt" && /\d{6,}d\b/.test(line)) return false
    if (["mindmap", "treeview", "treemap", "ishikawa"].includes(key) && (raw.match(/^\s*/)?.[0].length ?? 0) > 32) return false
  }
  return braces === 0 && !note
}
