import type { TuiCommand, TuiPlugin, TuiPluginModule, TuiToast } from "@opencode-ai/plugin/tui"
import type { TranscriptResult, Voice2TextConfig } from "./providers/types.js"
import { createV2UI, type V2Context } from "./v2.js"
import {
  appendableText,
  createRuntimeConfig,
  diffSuffix,
  ensureRuntimeSupport,
  loadConfig,
  startVoiceRecognition,
  type Voice2TextOptions,
  type VoiceRecognitionRun,
} from "./runtime.js"

const RECORDING_TOAST_DURATION = 60 * 60 * 1000
const FINAL_TRANSCRIPT_TIMEOUT_MS = 30_000

export type PromptTarget = {
  isCurrent: () => boolean
  append: (text: string) => void | Promise<void>
}

export type VoiceUI = {
  toast: (input: TuiToast) => void
  status?: (message?: string) => void
  capturePrompt: () => PromptTarget | undefined
  register: (command: TuiCommand) => () => void
}

async function appendTranscript(target: PromptTarget, config: Voice2TextConfig, text: string) {
  const nextText = config.appendTrailingSpace ? `${text} ` : text
  await target.append(nextText)
}

function recordingToast(ui: VoiceUI, message: string) {
  ui.status?.(message)
  ui.toast({
    title: "Voice2Text",
    message,
    variant: "info",
    duration: RECORDING_TOAST_DURATION,
  })
}

function clearToast(ui: VoiceUI) {
  ui.status?.()
  ui.toast({
    title: "",
    message: " ",
    variant: "info",
    duration: 1,
  })
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
    }
    const abort = () => {
      cleanup()
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(message))
    }, timeoutMs)
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
    promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error) => {
        cleanup()
        reject(error)
      },
    )
  })
}

async function setupVoice(ui: VoiceUI, options: Voice2TextOptions = {}) {
  const baseConfig = await loadConfig(options)

  let providerError = ""
  let runtime: ReturnType<typeof createRuntimeConfig> | undefined

  try {
    runtime = createRuntimeConfig(baseConfig)
  } catch (error) {
    providerError = error instanceof Error ? error.message : String(error)
  }

  const config = runtime?.config ?? baseConfig
  const provider = runtime?.provider

  type Recording = {
    phase: "starting" | "recording" | "transcribing" | "cancelling"
    controller: AbortController
    target: PromptTarget
    run?: VoiceRecognitionRun
    abort?: Promise<void>
    cancelArmed: boolean
    monitor?: ReturnType<typeof setInterval>
  }
  let active: Recording | undefined
  let disposed = false

  const toast = (message: string, variant: "info" | "warning" | "error" = "info") => {
    ui.toast({ title: "Voice2Text", message, variant, duration: 2500 })
  }

  const finish = (current: Recording) => {
    clearInterval(current.monitor)
    if (active !== current) return
    active = undefined
    clearToast(ui)
  }

  const abortRun = (current: Recording) => {
    return current.abort ??= current.run?.abort().catch(() => undefined) ?? Promise.resolve()
  }

  const cancel = async (current: Recording) => {
    current.phase = "cancelling"
    ui.status?.()
    current.controller.abort()
    await abortRun(current)
    finish(current)
  }

  const isCurrent = (current: Recording) => {
    if (disposed || active !== current || current.controller.signal.aborted) return false
    if (current.target.isCurrent()) return true
    void cancel(current)
    return false
  }

  const startRecording = async () => {
    if (active || disposed) return
    const target = ui.capturePrompt()
    if (!target) {
      toast("Open a prompt before starting voice input.", "warning")
      return
    }

    const current: Recording = { phase: "starting", controller: new AbortController(), target, cancelArmed: false }
    active = current
    // The host has no route-change subscription. Also check synchronously before every append.
    current.monitor = setInterval(() => { isCurrent(current) }, 50)
    recordingToast(ui, `Listening... press ${config.commandKeybind} to stop`)

    try {
      await ensureRuntimeSupport()
      if (!isCurrent(current)) return

      if (!provider) {
        finish(current)
        toast(providerError || `Unsupported provider '${config.provider}'.`, "warning")
        return
      }

      const configError = provider.validateConfig(config)
      if (configError) {
        finish(current)
        toast(configError, "warning")
        return
      }

      const run = await startVoiceRecognition(config, provider, {
        onStableText: async (text: string) => {
          const next = appendableText(text)
          if (!next || !isCurrent(current)) return
          await appendTranscript(target, config, next)
        },
      }, current.controller.signal)
      if (!isCurrent(current)) {
        await run.abort().catch(() => undefined)
        return
      }
      current.run = run
      current.phase = "recording"
    } catch (error) {
      if (!isCurrent(current)) return
      finish(current)
      toast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  const stopRecording = async () => {
    const current = active
    if (!current || current.phase !== "recording" || !current.run) return

    const finalTranscriptTimeoutMs = provider?.getFinalTranscriptTimeoutMs?.(config) ?? FINAL_TRANSCRIPT_TIMEOUT_MS
    current.phase = "transcribing"
    if (ui.status) recordingToast(ui, "Transcribing...")

    try {
      const result: TranscriptResult = await withTimeout(
        current.run.stop(),
        finalTranscriptTimeoutMs,
        "Timed out waiting for final transcript from the ASR provider.",
        current.controller.signal,
      )
      if (!isCurrent(current)) return

      const tail = diffSuffix(result.stableText, appendableText(result.text))

      if (tail) {
        await appendTranscript(current.target, config, tail)
      }
    } catch (error) {
      const report = isCurrent(current)
      current.controller.abort()
      await abortRun(current)
      if (report && !disposed && active === current) {
        finish(current)
        toast(error instanceof Error ? error.message : String(error), "error")
      }
    } finally {
      finish(current)
    }
  }

  const unregister = ui.register(
    {
      title: "Toggle voice input",
      value: "voice2text.toggle",
      description: `Capture microphone audio, send it to ${provider?.displayName ?? config.provider}, and append recognized text to the prompt`,
      keybind: config.commandKeybind,
      slash: { name: "voice2text", aliases: ["voice"] },
      hidden: false,
      onSelect: () => {
        if (disposed) return
        const current = active
        if (current?.phase === "cancelling") {
          toast("Cancelling the previous transcription...", "warning")
          return
        }
        if (current && !isCurrent(current)) return
        if (current?.phase === "transcribing") {
          if (current.cancelArmed) {
            toast("Cancelling the previous transcription...", "warning")
            void cancel(current)
            return
          }

          current.cancelArmed = true
          toast(`Still transcribing the previous recording. Press ${config.commandKeybind} again to cancel.`, "warning")
          return
        }

        if (current?.phase === "starting") {
          void cancel(current)
          return
        }

        if (current?.phase === "recording") {
          void stopRecording()
          return
        }

        void startRecording()
      },
    },
  )

  return async () => {
    disposed = true
    unregister()
    if (active) await cancel(active)
  }
}

const tui: TuiPlugin = async (api, options) => {
  const cleanup = await setupVoice({
    toast: (input) => api.ui.toast(input),
    register: (command) => api.command.register(() => [command]),
    capturePrompt: () => {
      const route = JSON.stringify(api.route.current)
      return {
        isCurrent: () => JSON.stringify(api.route.current) === route,
        append: async (text) => { await api.client.tui.appendPrompt({ text }) },
      }
    },
  }, options)
  api.lifecycle.onDispose(cleanup)
  if (api.lifecycle.signal.aborted) await cleanup()
}

const plugin = {
  id: "opencode.voice2text",
  tui,
  setup: async (context: V2Context) => setupVoice(await createV2UI(context), context.options),
} satisfies TuiPluginModule & { setup: (context: V2Context) => Promise<() => Promise<void>> }

export default plugin
