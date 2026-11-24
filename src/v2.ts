import type { Voice2TextOptions } from "./runtime.js"
import type { VoiceUI, PromptTarget } from "./index.js"
import type { JSX } from "@opentui/solid"

// Narrow structural contract: OpenCode v2.2.5 plugin/tui/context.ts and OpenTUI 0.8.0.
// OpenTUI is loaded only by v2 setup; v1 and Node CLI entrypoints do not load it.
type Renderable = {
  readonly visible: boolean
  readonly isDestroyed: boolean
  readonly parent: Renderable | null
  getChildren(): Renderable[]
  readonly traits?: unknown
  gotoBufferEnd?: () => boolean
  clearSelection?: () => boolean
  insertText?: (text: string) => void
}

export type V2Context = {
  readonly options: Readonly<Voice2TextOptions>
  readonly renderer: { readonly root: Renderable }
  readonly ui: {
    readonly toast: { show: VoiceUI["toast"] }
    readonly router: { current(): { readonly type: string; readonly sessionID?: string } }
    slot(claim: {
      append: "prompt.footer.status"
      render: (input: { readonly sessionID?: string }) => JSX.Element
    }): () => void
  }
  readonly keymap: {
    layer(factory: () => {
      mode?: string
      commands: {
        id: string
        title?: string
        description?: string
        bind?: string
        palette: true
        slash?: { name: string; aliases?: string[] }
        run: () => void
      }[]
    }): void
  }
}

type Prompt = Renderable & Required<Pick<Renderable, "clearSelection" | "gotoBufferEnd" | "insertText">>

function isPrompt(root: Renderable): root is Prompt {
  const traits = root.traits
  return (
    typeof traits === "object" && traits !== null &&
    "owner" in traits && traits.owner === "opencode" && "role" in traits && traits.role === "prompt" &&
    typeof root.clearSelection === "function" && typeof root.gotoBufferEnd === "function" && typeof root.insertText === "function"
  )
}

function findPrompt(root: Renderable): Prompt | undefined {
  if (!root.visible || root.isDestroyed) return
  if (isPrompt(root)) return root
  for (const child of root.getChildren()) {
    const prompt = findPrompt(child)
    if (prompt) return prompt
  }
}

export async function createV2UI(context: V2Context): Promise<VoiceUI> {
  const { jsx } = await import("@opentui/solid/jsx-runtime")
  let removeStatus: (() => void) | undefined
  return {
    toast: (input) => context.ui.toast.show(input),
    status: (message) => {
      removeStatus?.()
      removeStatus = undefined
      if (!message) return
      const { sessionID } = context.ui.router.current()
      removeStatus = context.ui.slot({
        append: "prompt.footer.status",
        render: (input) => input.sessionID === sessionID ? jsx("text", {
          id: "voice2text.status",
          content: `Voice2Text: ${message}`,
          wrapMode: "none",
          truncate: true,
          flexShrink: 1,
        }) : null,
      })
    },
    register: (command) => {
      context.keymap.layer(() => ({
        mode: "global", // Slash discovery runs in autocomplete mode, not the default base mode.
        commands: [{
          id: command.value,
          title: command.title,
          description: command.description,
          bind: command.keybind,
          palette: true,
          slash: command.slash,
          run: () => command.onSelect?.(),
        }],
      }))
      // The v2 host owns the layer and removes it on deactivation.
      return () => {}
    },
    capturePrompt: (): PromptTarget | undefined => {
      // router.current() is an in-place reconciled Solid store, not a snapshot.
      const { type, sessionID } = context.ui.router.current()
      if (type !== "home" && type !== "session") return
      const prompt = findPrompt(context.renderer.root)
      if (!prompt) return
      const isCurrent = () => {
        const next = context.ui.router.current()
        if (next.type !== type || next.sessionID !== sessionID) return false
        for (let node: Renderable | null = prompt; node; node = node.parent) {
          if (!node.visible || node.isDestroyed) return false
          if (node === context.renderer.root) return true
        }
        return false
      }
      return {
        isCurrent,
        append: (text) => {
          if (!isCurrent()) return
          // Use the live editor, not a saved text snapshot or a server broadcast to every TUI.
          prompt.clearSelection()
          prompt.gotoBufferEnd()
          prompt.insertText(text)
        },
      }
    },
  }
}
