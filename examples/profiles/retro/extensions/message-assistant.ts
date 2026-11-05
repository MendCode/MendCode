// message.assistant: a phosphor rail down the left edge and a bracketed tag on top.
//
// A view is a pure, synchronous function of its input (docs/views.md). `input.body` is the message as rows, already laid
// out 4 cells narrower than `width` so a rail fits. It runs in the terminal with the user's permissions: keep it fast.
export default {
  name: "retro-message-assistant",
  tui(api) {
    api.view("message.assistant", (input) => {
      const rail = input.ascii ? "| " : "▌ "
      const head = [{ text: rail, fg: "primary" }, { text: "[ASSISTANT]", fg: "primary", bold: true }]
      return [head, ...input.body.map((line) => [{ text: rail, fg: "primary" }, ...line])]
    })
  },
}
