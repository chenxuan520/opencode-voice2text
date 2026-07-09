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
const FINAL_TRANSCRIPT_TIMEOUT_MS = 30_000

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

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
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
  let transcribing: VoiceRecognitionRun | undefined
  let transcribingCancelArmed = false
  let transcribingCancelRequested = false

  const toast = (message: string, variant: "info" | "warning" | "error" = "info") => {
    api.ui.toast({ title: "Voice2Text", message, variant, duration: 2500 })
  }

  const resetTranscribingCancelState = () => {
    transcribingCancelArmed = false
    transcribingCancelRequested = false
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
    const finalTranscriptTimeoutMs = provider?.getFinalTranscriptTimeoutMs?.(config) ?? FINAL_TRANSCRIPT_TIMEOUT_MS
    active = undefined
    transcribing = current
    resetTranscribingCancelState()
    phase = "transcribing"

    try {
      const result: TranscriptResult = await withTimeout(
        current.stop(),
        finalTranscriptTimeoutMs,
        "Timed out waiting for final transcript from the ASR provider.",
      )
      if (transcribingCancelRequested) return

      const tail = diffSuffix(result.stableText, appendableText(result.text))

      if (tail) {
        await appendTranscript(api, config, tail)
      }
    } catch (error) {
      await current.abort().catch(() => undefined)
      if (!transcribingCancelRequested) {
        clearToast(api)
        toast(error instanceof Error ? error.message : String(error), "error")
      }
    } finally {
      transcribing = undefined
      resetTranscribingCancelState()
      phase = "idle"
      clearToast(api)
    }
  }

  api.command.register(() => [
    {
      title: "Toggle voice input",
      value: "voice2text.toggle",
      description: `Capture microphone audio, send it to ${provider?.displayName ?? config.provider}, and append recognized text to the prompt`,
      keybind: config.commandKeybind,
      slash: { name: "voice2text", aliases: ["voice"] },
      hidden: false,
      onSelect: () => {
        if (phase === "transcribing") {
          if (!transcribing) {
            toast("Still transcribing the previous recording.", "warning")
            return
          }

          if (transcribingCancelRequested) {
            toast("Cancelling the previous transcription...", "warning")
            return
          }

          if (transcribingCancelArmed) {
            transcribingCancelArmed = false
            transcribingCancelRequested = true
            toast("Cancelling the previous transcription...", "warning")
            void transcribing.abort().catch(() => undefined)
            return
          }

          transcribingCancelArmed = true
          toast(`Still transcribing the previous recording. Press ${config.commandKeybind} again to cancel.`, "warning")
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
    void transcribing?.abort().catch(() => undefined)
  })
}

const plugin: TuiPluginModule = {
  id: "opencode.voice2text",
  tui,
}

export default plugin
