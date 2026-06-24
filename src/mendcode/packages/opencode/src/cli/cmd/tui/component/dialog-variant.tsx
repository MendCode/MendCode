import { createMemo } from "solid-js"
import { useLocal } from "@tui/context/local"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"

export function DialogVariant(props: { model?: { providerID: string; modelID: string } } = {}) {
  const local = useLocal()
  const dialog = useDialog()

  const options = createMemo(() => {
    return [
      {
        value: "default",
        title: "Default",
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(undefined, { model: props.model })
        },
      },
      ...local.model.variant.list(props.model).map((variant) => ({
        value: variant,
        title: variant,
        onSelect: () => {
          dialog.clear()
          local.model.variant.set(variant, { model: props.model })
        },
      })),
    ]
  })

  return (
    <DialogSelect<string>
      options={options()}
      title={"Select variant"}
      current={local.model.variant.selected(props.model)}
      flat={true}
    />
  )
}
