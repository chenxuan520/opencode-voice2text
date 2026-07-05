import type { PluginOptions } from "@opencode-ai/plugin"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { TranscriptResult, Voice2TextConfig } from "./providers/types.js"
import {
  appendableText,
  createRuntimeConfig,
  diffSuffix,
  ensureRuntimeSupport,
  loadConfig,
  startVoiceRecognition,
  type Voice2TextOptions as RuntimeVoice2TextOptions,
  type VoiceRecognitionRun,
} from "./runtime.js"

const RECORDING_TOAST_DURATION = 60 * 60 * 1000

type Voice2TextOptions = PluginOptions & RuntimeVoice2TextOptions

async function appendTranscript(api: TuiPluginApi, config: Voice2TextConfig, text: string) {
  const nextText = config.appendTrailingSpace ? `${text} ` : text
  await api.client.tui.appendPrompt({ text: nextText })
}

function recordingToast(api: TuiPluginApi, message: string) {
  api.ui.toast({
    title: "Voice2Text",
    message,
    variant: "info",
    duration: RECORDING_TOAST_DURATION,
  })
}

function clearToast(api: TuiPluginApi) {
  api.ui.toast({
    title: "",
    message: " ",
    variant: "info",
    duration: 1,
  })
}

const tui: TuiPlugin = async (api, options) => {
  const baseConfig = await loadConfig((options ?? {}) as Voice2TextOptions)

  let providerError = ""
  let runtime: ReturnType<typeof createRuntimeConfig> | undefined

  try {
    runtime = createRuntimeConfig(baseConfig)
  } catch (error) {
    providerError = error instanceof Error ? error.message : String(error)
  }

  const config = runtime?.config ?? baseConfig
  const provider = runtime?.provider

  let phase: "idle" | "recording" | "transcribing" = "idle"
  let active: VoiceRecognitionRun | undefined

  const toast = (message: string, variant: "info" | "warning" | "error" = "info") => {
    api.ui.toast({ title: "Voice2Text", message, variant, duration: 2500 })
  }

  const startRecording = async () => {
    if (phase !== "idle") return

    phase = "recording"
    recordingToast(api, `Listening... press ${config.commandKeybind} to stop`)

    try {
      await ensureRuntimeSupport()

      if (!provider) {
        phase = "idle"
        clearToast(api)
        toast(providerError || `Unsupported provider '${config.provider}'.`, "warning")
        return
      }

      const configError = provider.validateConfig(config)
      if (configError) {
        phase = "idle"
        clearToast(api)
        toast(configError, "warning")
        return
      }

      active = await startVoiceRecognition(config, provider, {
        onStableText: async (text: string) => {
          const next = appendableText(text)
          if (!next) return
          await appendTranscript(api, config, next)
        },
      })
    } catch (error) {
      phase = "idle"
      clearToast(api)
      toast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  const stopRecording = async () => {
    if (phase !== "recording" || !active) return

    const current = active
    active = undefined
    phase = "transcribing"

    try {
      const result: TranscriptResult = await current.stop()
      const tail = diffSuffix(result.stableText, appendableText(result.text))

      if (tail) {
        await appendTranscript(api, config, tail)
      }
    } catch (error) {
      await current.abort().catch(() => undefined)
      clearToast(api)
      toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
      phase = "idle"
      clearToast(api)
    }
  }

  api.command.register(() => [
    {
      title: "Toggle voice input",
      value: "voice2text.toggle",
      description: `Stream microphone audio to ${provider?.displayName ?? config.provider} and append recognized text to the prompt`,
      keybind: config.commandKeybind,
      slash: { name: "voice2text", aliases: ["voice"] },
      hidden: false,
      onSelect: () => {
        if (phase === "transcribing") {
          toast("Still transcribing the previous recording.", "warning")
          return
        }

        if (phase === "recording") {
          void stopRecording()
          return
        }

        void startRecording()
      },
    },
  ])

  api.lifecycle.onDispose(() => {
    void active?.abort().catch(() => undefined)
  })
}

const plugin: TuiPluginModule = {
  id: "opencode.voice2text",
  tui,
}

export default plugin
