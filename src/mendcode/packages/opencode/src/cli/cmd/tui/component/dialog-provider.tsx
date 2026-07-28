import { createMemo, createSignal, onMount, Show } from "solid-js"
import { useSync } from "@tui/context/sync"
import { map, pipe, sortBy } from "remeda"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useSDK } from "../context/sdk"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { Link } from "../ui/link"
import { useTheme } from "../context/theme"
import { TextAttributes } from "@opentui/core"
import type { ProviderAuthAuthorization, ProviderAuthMethod } from "@mendcode/sdk/v2"
import { DialogModel } from "./dialog-model"
import { useKeyboard } from "@opentui/solid"
import * as Clipboard from "@tui/util/clipboard"
import { useToast } from "../ui/toast"
import { isConsoleManagedProvider, providerDisplayName } from "@tui/util/provider-origin"
import { useConnected } from "./use-connected"
import { Keybind } from "@/util/keybind"

const PROVIDER_PRIORITY: Record<string, number> = {
  openai: 0,
  opencode: 1,
  "opencode-go": 2,
  "github-copilot": 3,
  "claude-code": 4,
  anthropic: 5,
  google: 6,
}

function providerErrorMessage(error: unknown) {
  if (typeof error === "string") return error
  if (typeof error === "object" && error !== null) {
    if ("message" in error && typeof error.message === "string") return error.message
    if ("error" in error && typeof error.error === "string") return error.error
    if ("data" in error && typeof error.data === "object" && error.data !== null) {
      const data = error.data
      if ("message" in data && typeof data.message === "string") return data.message
    }
  }
  return "Provider authorization failed."
}

type DialogProviderPostAuth = "model-picker" | "close"

type DialogProviderProps = {
  postAuth?: DialogProviderPostAuth
  onAuthReady?: () => void
}

function completeProviderAuth(input: {
  dialog: ReturnType<typeof useDialog>
  providerID: string
  postAuth?: DialogProviderPostAuth
  onAuthReady?: () => void
}) {
  input.onAuthReady?.()
  if (input.postAuth === "close") {
    input.dialog.clear()
    return
  }
  input.dialog.replace(() => <DialogModel providerID={input.providerID} />)
}

function ProviderKeyDescription(props: { providerID: string }) {
  const { theme } = useTheme()
  const isZen = props.providerID === "opencode"
  const isGo = props.providerID === "opencode-go"
  if (!isZen && !isGo) return undefined

  return (
    <box gap={1} paddingBottom={1}>
      <text fg={theme.textMuted} wrapMode="word">
        {isZen
          ? "opencode Zen gives you access to top coding models through a single API key."
          : "opencode Go is a subscription provider for reliable access to popular open coding models."}
      </text>
      <box flexDirection="row" gap={1}>
        <text fg={theme.text}>Go to</text>
        <Link href="https://opencode.ai/zen" fg={theme.primary} />
        <text fg={theme.text}>{isGo ? "and enable opencode Go" : "to get a key"}</text>
      </box>
    </box>
  )
}

export function createDialogProviderOptions(props: DialogProviderProps = {}) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const { theme } = useTheme()
  const onboarded = useConnected()
  const options = createMemo(() => {
    return pipe(
      sync.data.provider_next.all,
      sortBy((x) => PROVIDER_PRIORITY[x.id] ?? 99),
      map((provider) => {
        const consoleManaged = isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, provider.id)
        const connected = sync.data.provider_next.connected.includes(provider.id)

        return {
          title: providerDisplayName(provider),
          value: provider.id,
          description: {
            anthropic: "(API key)",
            openai: "(ChatGPT Plus/Pro or API key)",
            opencode: "(opencode Zen)",
            "opencode-go": "(Bring your own Go provider access)",
            "claude-code": "(Claude Code CLI)",
          }[provider.id],
          footer: consoleManaged ? sync.data.console_state.activeOrgName : undefined,
          category: provider.id in PROVIDER_PRIORITY ? "Popular" : "Other",
          gutter: connected && onboarded() ? () => <text fg={theme.success}>✓</text> : undefined,
          async onSelect() {
            if (consoleManaged) return

            const methods = sync.data.provider_auth[provider.id] ?? [
              {
                type: "api",
                label: "API key",
              },
            ]
            let index: number | null = 0
            if (methods.length > 1) {
              index = await new Promise<number | null>((resolve) => {
                dialog.replace(
                  () => (
                    <DialogSelect
                      title="Select auth method"
                      options={methods.map((x, index) => ({
                        title: x.label,
                        value: index,
                      }))}
                      onSelect={(option) => resolve(option.value)}
                    />
                  ),
                  () => resolve(null),
                )
              })
            }
            if (index == null) return
            const method = methods[index]
            if (method.type === "oauth") {
              let inputs: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({
                  dialog,
                  prompts: method.prompts,
                })
                if (!value) return
                inputs = value
              }

              const result = await sdk.client.provider.oauth.authorize({
                providerID: provider.id,
                method: index,
                inputs,
              })
              if (result.error) {
                toast.show({
                  variant: "error",
                  message: providerErrorMessage(result.error),
                })
                dialog.clear()
                return
              }
              if (result.data?.method === "code") {
                dialog.replace(() => (
                  <CodeMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                    postAuth={props.postAuth}
                    onAuthReady={props.onAuthReady}
                  />
                ))
              }
              if (result.data?.method === "auto") {
                dialog.replace(() => (
                  <AutoMethod
                    providerID={provider.id}
                    title={method.label}
                    index={index}
                    authorization={result.data!}
                    postAuth={props.postAuth}
                    onAuthReady={props.onAuthReady}
                  />
                ))
              }
            }
            if (method.type === "api") {
              let metadata: Record<string, string> | undefined
              if (method.prompts?.length) {
                const value = await PromptsMethod({ dialog, prompts: method.prompts })
                if (!value) return
                metadata = value
              }
              return dialog.replace(() => (
                <ApiMethod
                  providerID={provider.id}
                  title={method.label}
                  metadata={metadata}
                  postAuth={props.postAuth}
                  onAuthReady={props.onAuthReady}
                />
              ))
            }
          },
        }
      }),
    )
  })
  return options
}

export function DialogProvider(props: DialogProviderProps = {}) {
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const options = createDialogProviderOptions(props)
  const [selectedProviderID, setSelectedProviderID] = createSignal<string>()

  function canDisconnect(providerID: string | undefined) {
    if (!providerID) return false
    const provider = sync.data.provider_next.all.find((provider) => provider.id === providerID)
    if (!provider) return false
    if (provider.source === "api") {
      return !isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
    }
    if (provider.source !== "custom") return false
    if (!sync.data.provider_auth[providerID]?.length) return false
    return !isConsoleManagedProvider(sync.data.console_state.consoleManagedProviders, providerID)
  }

  const selectedProvider = createMemo(() => {
    const providerID = selectedProviderID() ?? options()[0]?.value
    if (!providerID) return
    return sync.data.provider_next.all.find((provider) => provider.id === providerID)
  })

  const disconnectKeybind = createMemo(() => {
    const provider = selectedProvider()
    if (!provider || !canDisconnect(provider.id)) return []
    return [
      {
        keybind: Keybind.parse("d")[0],
        title: "Disconnect provider",
        onTrigger: async () => {
          const confirmed = await DialogConfirm.show(
            dialog,
            "Remove saved auth",
            `Disconnect ${providerDisplayName(provider)}? You can reconnect this provider later.`,
          )
          if (!confirmed) return

          const result = await sdk.client.auth.remove({ providerID: provider.id })
          if (result.error) {
            toast.show({
              variant: "error",
              message: providerErrorMessage(result.error),
            })
            dialog.replace(() => <DialogProvider {...props} />)
            return
          }

          await sdk.client.instance.dispose()
          await sync.bootstrap()
          props.onAuthReady?.()
          const stillDetected = sync.data.provider_next.connected.includes(provider.id)
          toast.show({
            variant: "success",
            message: stillDetected ? "Saved auth removed. Provider still detected." : "Provider disconnected.",
          })
          dialog.replace(() => <DialogProvider {...props} />)
        },
      },
    ]
  })

  return (
    <DialogSelect
      title="Provider Manager"
      options={options()}
      onMove={(option) => setSelectedProviderID(option.value)}
      keybind={disconnectKeybind()}
    />
  )
}

interface AutoMethodProps {
  index: number
  providerID: string
  title: string
  authorization: ProviderAuthAuthorization
  postAuth?: DialogProviderPostAuth
  onAuthReady?: () => void
}
function AutoMethod(props: AutoMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const dialog = useDialog()
  const sync = useSync()
  const toast = useToast()

  useKeyboard((evt) => {
    if (evt.name === "c" && !evt.ctrl && !evt.meta) {
      const code = props.authorization.instructions.match(/[A-Z0-9]{4}-[A-Z0-9]{4,5}/)?.[0] ?? props.authorization.url
      Clipboard.copy(code)
        .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
        .catch(toast.error)
    }
  })

  onMount(async () => {
    const result = await sdk.client.provider.oauth.callback({
      providerID: props.providerID,
      method: props.index,
    })
    if (result.error) {
      toast.show({
        variant: "error",
        message: providerErrorMessage(result.error),
      })
      dialog.clear()
      return
    }
    await sdk.client.instance.dispose()
    await sync.bootstrap()
    completeProviderAuth({ ...props, dialog })
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        <Link href={props.authorization.url} fg={theme.primary} />
        <text fg={theme.textMuted}>{props.authorization.instructions}</text>
      </box>
      <text fg={theme.textMuted}>Waiting for authorization...</text>
      <text fg={theme.text}>
        c <span style={{ fg: theme.textMuted }}>copy</span>
      </text>
    </box>
  )
}

interface CodeMethodProps {
  index: number
  title: string
  providerID: string
  authorization: ProviderAuthAuthorization
  postAuth?: DialogProviderPostAuth
  onAuthReady?: () => void
}
function CodeMethod(props: CodeMethodProps) {
  const { theme } = useTheme()
  const sdk = useSDK()
  const sync = useSync()
  const dialog = useDialog()
  const [error, setError] = createSignal(false)

  return (
    <DialogPrompt
      title={props.title}
      placeholder="Authorization code"
      onConfirm={async (value) => {
        const { error } = await sdk.client.provider.oauth.callback({
          providerID: props.providerID,
          method: props.index,
          code: value,
        })
        if (!error) {
          await sdk.client.instance.dispose()
          await sync.bootstrap()
          completeProviderAuth({ ...props, dialog })
          return
        }
        setError(true)
      }}
      description={() => (
        <box gap={1}>
          <text fg={theme.textMuted}>{props.authorization.instructions}</text>
          <Link href={props.authorization.url} fg={theme.primary} />
          <Show when={error()}>
            <text fg={theme.error}>Invalid code</text>
          </Show>
        </box>
      )}
    />
  )
}

interface ApiMethodProps {
  providerID: string
  title: string
  metadata?: Record<string, string>
  postAuth?: DialogProviderPostAuth
  onAuthReady?: () => void
}
function ApiMethod(props: ApiMethodProps) {
  const dialog = useDialog()
  const sdk = useSDK()
  const sync = useSync()

  return (
    <DialogPrompt
      title={props.title}
      placeholder="API key"
      description={() => <ProviderKeyDescription providerID={props.providerID} />}
      onConfirm={async (value) => {
        if (!value) return
        await sdk.client.auth.set({
          providerID: props.providerID,
          auth: {
            type: "api",
            key: value,
            ...(props.metadata ? { metadata: props.metadata } : {}),
          },
        })
        await sdk.client.instance.dispose()
        await sync.bootstrap()
        completeProviderAuth({ ...props, dialog })
      }}
    />
  )
}

interface PromptsMethodProps {
  dialog: ReturnType<typeof useDialog>
  prompts: NonNullable<ProviderAuthMethod["prompts"]>[number][]
}
async function PromptsMethod(props: PromptsMethodProps) {
  const inputs: Record<string, string> = {}
  for (const prompt of props.prompts) {
    if (prompt.when) {
      const value = inputs[prompt.when.key]
      if (value === undefined) continue
      const matches = prompt.when.op === "eq" ? value === prompt.when.value : value !== prompt.when.value
      if (!matches) continue
    }

    if (prompt.type === "select") {
      const value = await new Promise<string | null>((resolve) => {
        props.dialog.replace(
          () => (
            <DialogSelect
              title={prompt.message}
              options={prompt.options.map((x) => ({
                title: x.label,
                value: x.value,
                description: x.hint,
              }))}
              onSelect={(option) => resolve(option.value)}
            />
          ),
          () => resolve(null),
        )
      })
      if (value === null) return null
      inputs[prompt.key] = value
      continue
    }

    const value = await new Promise<string | null>((resolve) => {
      props.dialog.replace(
        () => (
          <DialogPrompt title={prompt.message} placeholder={prompt.placeholder} onConfirm={(value) => resolve(value)} />
        ),
        () => resolve(null),
      )
    })
    if (value === null) return null
    inputs[prompt.key] = value
  }
  return inputs
}
