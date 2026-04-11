import type { TuiPluginModule } from "@opencode-ai/plugin/tui"

const plugin: TuiPluginModule = {
  id: "opencode.voice2text.debug",
  tui: async (api) => {
    api.command.register(() => [
      {
        title: "Voice2Text debug",
        value: "voice2text.debug",
        description: "Show a debug toast from the voice plugin",
        keybind: "ctrl+g",
        hidden: false,
        onSelect: () => {
          api.ui.toast({
            title: "Voice2Text",
            message: "debug command reached",
            variant: "info",
            duration: 2500,
          })
        },
      },
    ])
  },
}

export default plugin
