// A responsive modal, a named action and a key (docs/extensions-tui.md, "A responsive modal").
// Copy it to `<data dir>/extensions/branches.ts`, or `<project>/.mendcode/extensions/`.
//
//   ctrl+x B, or "Pick a branch" in the palette (ctrl+p)   opens the card over the chat
//   "f6": "action:branches.pick" in keybindings.json       the same from a key of your own
//   ↑↓ move · enter inserts the branch into the prompt · esc closes
export default {
  name: "branches",
  tui(api) {
    const branches = ["main", "integration/all", "lane/ext-modals", "release/1.4"]
    let selected = 0
    api.modal("branches", {
      title: "Branches",
      // The whole terminal when it is narrow, half of it from 70 columns up (the card always leaves two columns free).
      width: ({ breakpoint }) => (breakpoint === "compact" ? 1 : 0.5),
      // Called every frame with the card's inner size and the terminal's breakpoint: no resize listener needed.
      render: ({ width, height, breakpoint }) => {
        const twoColumns = breakpoint === "wide" || breakpoint === "xl"
        const rows = branches.slice(0, Math.max(1, height - 1)).map((name, i) => {
          const mark = i === selected ? "› " : "  "
          const detail = twoColumns ? name.padEnd(Math.floor(width / 2)) + (i === 0 ? "default" : "") : name
          return [{ text: mark + detail, fg: i === selected ? "primary" : "text" }]
        })
        return [...rows, [{ text: "enter insert · ↑↓ move", fg: "muted" }]]
      },
      onKey: (key, actions) => {
        if (key === "up" || key === "down") {
          selected = (selected + (key === "up" ? branches.length - 1 : 1)) % branches.length
          return true
        }
        if (key === "enter") {
          actions.insert(branches[selected])
          actions.close()
          return true
        }
        return false
      },
    })
    api.action("branches.pick", (actions) => actions.openModal("branches"), { title: "Pick a branch", description: "insert a branch name into the prompt" })
    api.key("leader+shift+b", (actions) => actions.openModal("branches"))
  },
}
