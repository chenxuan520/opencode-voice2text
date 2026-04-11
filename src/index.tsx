import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"
import type { PluginOptions } from "@opencode-ai/plugin"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { getProviderById } from "./providers/index.js"
import type { RecognitionSession, TranscriptResult, Voice2TextConfig } from "./providers/types.js"

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config/opencode/voice2text.local.json")
const DEFAULT_CHUNK_MS = 200
const DEFAULT_RATE = 16000
const DEFAULT_BITS = 16
const DEFAULT_CHANNELS = 1
const DEFAULT_END_WINDOW_SIZE = 800
const RECORDING_TOAST_DURATION = 60 * 60 * 1000

type Voice2TextOptions = PluginOptions & {
  commandKeybind?: string
  provider?: string
  providerConfig?: Record<string, unknown>
  endpoint?: string
  appId?: string
  accessToken?: string
  resourceId?: string
  language?: string
  chunkMs?: number
  endWindowSize?: number
  maxDurationSeconds?: number
  appendTrailingSpace?: boolean
  rate?: number
  bits?: number
  channels?: number
}

type RecorderSession = {
  done: Promise<void>
  stop: () => void
}

function str(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function num(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function bool(value: unknown, fallback: boolean) {
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  return fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function appendableText(text: unknown) {
  return typeof text === "string" ? text.trim() : ""
}

function diffSuffix(previous: string, next: string) {
  if (!next) return ""
  if (!previous) return next
  if (next.startsWith(previous)) return next.slice(previous.length).trim()
  return ""
}

function platformLabel() {
  if (process.platform === "darwin") return "macOS"
  if (process.platform === "linux") return "Linux"
  return process.platform
}

function installHint() {
  if (process.platform === "darwin") return "Missing recorder 'rec'. Install Sox with: brew install sox"
  if (process.platform === "linux") return "Missing recorder 'rec'. Install Sox with: sudo apt install sox"
  return "Missing recorder 'rec'. Install Sox before using voice input."
}

async function commandExists(command: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn("which", [command], { stdio: "ignore" })
    child.on("close", (code) => resolve(code === 0))
    child.on("error", () => resolve(false))
  })
}

async function ensureRuntimeSupport() {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error(`opencode-voice2text currently supports macOS and Linux. Current platform: ${platformLabel()}`)
  }

  if (!(await commandExists("rec"))) {
    throw new Error(installHint())
  }
}

async function readLocalConfig(configPath: string) {
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>
  } catch (error: any) {
    if (error?.code === "ENOENT") return {}
    throw error
  }
}

function buildLegacyProviderConfig(merged: Record<string, unknown>, env: NodeJS.ProcessEnv) {
  const providerConfig: Record<string, unknown> = {}

  const endpoint = str(merged.endpoint ?? env.OPENCODE_VOICE2TEXT_ENDPOINT)
  const appId = str(merged.appId ?? env.OPENCODE_VOICE2TEXT_APP_ID)
  const accessToken = str(merged.accessToken ?? env.OPENCODE_VOICE2TEXT_ACCESS_TOKEN)
  const resourceId = str(merged.resourceId ?? env.OPENCODE_VOICE2TEXT_RESOURCE_ID)

  if (endpoint) providerConfig.endpoint = endpoint
  if (appId) providerConfig.appId = appId
  if (accessToken) providerConfig.accessToken = accessToken
  if (resourceId) providerConfig.resourceId = resourceId

  return providerConfig
}

async function loadConfig(options: Voice2TextOptions = {}): Promise<Voice2TextConfig> {
  const configPath = process.env.OPENCODE_VOICE2TEXT_LOCAL_CONFIG || DEFAULT_CONFIG_PATH
  const local = await readLocalConfig(configPath)
  const env = process.env
  const merged = { ...local, ...options }
  const nestedProviderConfig = {
    ...(isRecord(local.providerConfig) ? local.providerConfig : {}),
    ...(isRecord(options.providerConfig) ? options.providerConfig : {}),
  }

  return {
    configPath,
    commandKeybind: str(merged.commandKeybind, "ctrl+s"),
    provider: str(merged.provider ?? env.OPENCODE_VOICE2TEXT_PROVIDER, "volcengine"),
    language: str(merged.language ?? env.OPENCODE_VOICE2TEXT_LANGUAGE),
    chunkMs: num(merged.chunkMs ?? env.OPENCODE_VOICE2TEXT_CHUNK_MS, DEFAULT_CHUNK_MS),
    endWindowSize: num(merged.endWindowSize ?? env.OPENCODE_VOICE2TEXT_END_WINDOW_SIZE, DEFAULT_END_WINDOW_SIZE),
    maxDurationSeconds: num(merged.maxDurationSeconds ?? env.OPENCODE_VOICE2TEXT_MAX_DURATION_SECONDS, 180),
    appendTrailingSpace: bool(merged.appendTrailingSpace ?? env.OPENCODE_VOICE2TEXT_APPEND_TRAILING_SPACE, true),
    rate: num(merged.rate ?? env.OPENCODE_VOICE2TEXT_SAMPLE_RATE, DEFAULT_RATE),
    bits: num(merged.bits ?? env.OPENCODE_VOICE2TEXT_BITS, DEFAULT_BITS),
    channels: num(merged.channels ?? env.OPENCODE_VOICE2TEXT_CHANNELS, DEFAULT_CHANNELS),
    providerConfig: {
      ...nestedProviderConfig,
      ...buildLegacyProviderConfig(merged, env),
    },
  }
}

function createRecorder(config: Voice2TextConfig, onChunk: (chunk: Buffer) => Promise<void> | void): RecorderSession {
  const child = spawn(
    "rec",
    [
      "-q",
      "-t",
      "raw",
      "-r",
      String(config.rate),
      "-c",
      String(config.channels),
      "-b",
      String(config.bits),
      "-e",
      "signed-integer",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  )

  let stderr = ""
  let stopRequested = false
  let finished = false
  let streamError: Error | undefined
  let writeChain = Promise.resolve()

  child.stdout?.on("data", (chunk: Buffer) => {
    writeChain = writeChain.then(async () => {
      if (streamError) return
      try {
        await onChunk(chunk)
      } catch (error) {
        streamError = error instanceof Error ? error : new Error(String(error))
        stopRequested = true
        child.kill("SIGINT")
      }
    })
  })

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const timer = setTimeout(() => {
    stopRequested = true
    child.kill("SIGINT")
  }, config.maxDurationSeconds * 1000)

  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      finished = true
      reject(error?.code === "ENOENT" ? new Error(installHint()) : error)
    })

    child.on("close", async (code, signal) => {
      clearTimeout(timer)
      finished = true
      await writeChain

      if (streamError) {
        reject(streamError)
        return
      }

      if (code === 0 || signal === "SIGINT" || stopRequested) {
        resolve()
        return
      }

      reject(new Error(stderr.trim() || `Recording failed with code ${code ?? "unknown"}`))
    })
  })

  return {
    done,
    stop() {
      if (finished || child.killed) return
      stopRequested = true
      child.kill("SIGINT")
    },
  }
}

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
  let provider = undefined

  try {
    provider = getProviderById(baseConfig.provider)
  } catch (error) {
    providerError = error instanceof Error ? error.message : String(error)
  }

  const config = provider
    ? {
        ...baseConfig,
        providerConfig: provider.normalizeConfig(baseConfig.providerConfig),
      }
    : baseConfig

  let phase: "idle" | "recording" | "transcribing" = "idle"
  let active:
    | {
        recorder: RecorderSession
        stream: RecognitionSession
        pending: Buffer
        chunkBytes: number
      }
    | undefined

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

      const stream = await provider.createRecognition(config, {
        onStableText: async (text: string) => {
          const next = appendableText(text)
          if (!next) return
          await appendTranscript(api, config, next)
        },
      })

      const session = {
        stream,
        pending: Buffer.alloc(0),
        chunkBytes: Math.max(1, Math.floor((config.rate * config.channels * (config.bits / 8) * config.chunkMs) / 1000)),
        recorder: undefined as unknown as RecorderSession,
      }

      const flushPending = async () => {
        while (session.pending.length >= session.chunkBytes) {
          const chunk = session.pending.subarray(0, session.chunkBytes)
          session.pending = session.pending.subarray(session.chunkBytes)
          session.stream.write(chunk)
        }
      }

      session.recorder = createRecorder(config, async (chunk) => {
        session.pending = Buffer.concat([session.pending, chunk])
        await flushPending()
      })

      active = session
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
      current.recorder.stop()
      await current.recorder.done
      const finalChunk = current.pending.length > 0 ? current.pending : undefined
      const result: TranscriptResult = await current.stream.finish(finalChunk)
      const tail = diffSuffix(result.stableText, appendableText(result.text))

      if (tail) {
        await appendTranscript(api, config, tail)
      }
    } catch (error) {
      await current.stream.abort().catch(() => undefined)
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
    active?.recorder.stop()
    void active?.stream.abort().catch(() => undefined)
  })
}

const plugin: TuiPluginModule = {
  id: "opencode.voice2text",
  tui,
}

export default plugin
