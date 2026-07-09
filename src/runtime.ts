import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"
import { getProviderById } from "./providers/index.js"
import type { RecognitionCallbacks, RecognitionSession, TranscriptResult, Voice2TextConfig, VoiceProvider } from "./providers/types.js"

const DEFAULT_CHUNK_MS = 200
const DEFAULT_RATE = 16000
const DEFAULT_BITS = 16
const DEFAULT_CHANNELS = 1
const DEFAULT_END_WINDOW_SIZE = 800
const RECORDER_FORCE_KILL_TIMEOUT_MS = 5000

export type Voice2TextOptions = Record<string, unknown> & {
  configPath?: string
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
  mimoApiKey?: string
  mimoEndpoint?: string
  mimoModel?: string
}

type RecorderSession = {
  done: Promise<void>
  stop: () => void
}

export type Voice2TextRuntime = {
  config: Voice2TextConfig
  provider: VoiceProvider
}

export type VoiceRecognitionRun = {
  stop: () => Promise<TranscriptResult>
  abort: () => Promise<void>
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

function selectProviderConfig(value: unknown, providerId: string, ownerProviderId = "") {
  if (!isRecord(value)) return {}

  const nested = value[providerId]
  if (isRecord(nested)) {
    return nested
  }

  if (ownerProviderId && ownerProviderId !== providerId) {
    return {}
  }

  return value
}

export function appendableText(text: unknown) {
  return typeof text === "string" ? text.trim() : ""
}

export function diffSuffix(previous: string, next: string) {
  if (!next) return ""
  if (!previous) return next
  if (next.startsWith(previous)) return next.slice(previous.length).trim()
  return ""
}

function platformLabel() {
  if (process.platform === "darwin") return "macOS"
  if (process.platform === "linux") return "Linux"
  if (process.platform === "win32") return "Windows"
  return process.platform
}

export function defaultConfigPath() {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA
    if (appData) {
      return path.join(appData, "opencode", "voice2text.local.json")
    }
  }

  return path.join(os.homedir(), ".config", "opencode", "voice2text.local.json")
}

function recorderCommand() {
  return process.platform === "win32" ? "sox" : "rec"
}

function installHint() {
  if (process.platform === "darwin") return "Missing recorder 'rec'. Install Sox with: brew install sox"
  if (process.platform === "linux") return "Missing recorder 'rec'. Install Sox with: sudo apt install sox"
  if (process.platform === "win32") {
    return "Missing recorder 'sox'. Install SoX for Windows from https://sourceforge.net/projects/sox/ and ensure sox.exe is in PATH"
  }
  return `Missing recorder '${recorderCommand()}'. Install Sox before using voice input.`
}

async function commandExists(command: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [command], { stdio: "ignore", windowsHide: true })
    child.on("close", (code) => resolve(code === 0))
    child.on("error", () => resolve(false))
  })
}

export async function ensureRuntimeSupport() {
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") {
    throw new Error(`opencode-voice2text currently supports macOS, Linux, and Windows. Current platform: ${platformLabel()}`)
  }

  if (!(await commandExists(recorderCommand()))) {
    throw new Error(installHint())
  }
}

async function readLocalConfig(configPaths: string[]) {
  const primaryConfigPath = configPaths[0] || defaultConfigPath()

  for (const configPath of configPaths) {
    try {
      return {
        configPath,
        local: JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>,
      }
    } catch (error: any) {
      if (error?.code === "ENOENT") continue
      throw error
    }
  }

  return {
    configPath: primaryConfigPath,
    local: {},
  }
}

function buildLegacyVolcengineProviderConfig(
  local: Record<string, unknown>,
  options: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
) {
  const providerConfig: Record<string, unknown> = {}

  const endpoint = str(options.endpoint ?? env.OPENCODE_VOICE2TEXT_ENDPOINT ?? local.endpoint)
  const appId = str(options.appId ?? env.OPENCODE_VOICE2TEXT_APP_ID ?? local.appId)
  const accessToken = str(options.accessToken ?? env.OPENCODE_VOICE2TEXT_ACCESS_TOKEN ?? local.accessToken)
  const resourceId = str(options.resourceId ?? env.OPENCODE_VOICE2TEXT_RESOURCE_ID ?? local.resourceId)

  if (endpoint) providerConfig.endpoint = endpoint
  if (appId) providerConfig.appId = appId
  if (accessToken) providerConfig.accessToken = accessToken
  if (resourceId) providerConfig.resourceId = resourceId

  return providerConfig
}

function buildMimoProviderConfig(
  local: Record<string, unknown>,
  options: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
) {
  const providerConfig: Record<string, unknown> = {}

  const apiKey = str(options.mimoApiKey ?? env.OPENCODE_VOICE2TEXT_MIMO_API_KEY ?? local.mimoApiKey)
  const endpoint = str(options.mimoEndpoint ?? env.OPENCODE_VOICE2TEXT_MIMO_ENDPOINT ?? local.mimoEndpoint)
  const model = str(options.mimoModel ?? env.OPENCODE_VOICE2TEXT_MIMO_MODEL ?? local.mimoModel)

  if (apiKey) providerConfig.apiKey = apiKey
  if (endpoint) providerConfig.endpoint = endpoint
  if (model) providerConfig.model = model

  return providerConfig
}

function buildProviderConfigOverrides(
  providerId: string,
  local: Record<string, unknown>,
  options: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
) {
  if (providerId === "mimo") {
    return buildMimoProviderConfig(local, options, env)
  }

  return buildLegacyVolcengineProviderConfig(local, options, env)
}

export async function loadConfig(
  options: Voice2TextOptions = {},
  defaultConfigPaths: string | string[] = defaultConfigPath(),
): Promise<Voice2TextConfig> {
  const explicitConfigPath = str(options.configPath ?? process.env.OPENCODE_VOICE2TEXT_LOCAL_CONFIG)
  const configuredPaths = explicitConfigPath
    ? [explicitConfigPath]
    : Array.isArray(defaultConfigPaths)
      ? defaultConfigPaths
      : [defaultConfigPaths]
  const { configPath, local } = await readLocalConfig(configuredPaths)
  const env = process.env
  const merged = { ...local, ...options }
  const provider = str(options.provider ?? env.OPENCODE_VOICE2TEXT_PROVIDER ?? local.provider, "volcengine")
  const localProviderConfig = selectProviderConfig(local.providerConfig, provider, str(local.provider, "volcengine"))
  const optionProviderConfig = selectProviderConfig(options.providerConfig, provider, str(options.provider))

  return {
    configPath,
    commandKeybind: str(merged.commandKeybind, "ctrl+s"),
    provider,
    language: str(options.language ?? env.OPENCODE_VOICE2TEXT_LANGUAGE ?? local.language),
    chunkMs: num(options.chunkMs ?? env.OPENCODE_VOICE2TEXT_CHUNK_MS ?? local.chunkMs, DEFAULT_CHUNK_MS),
    endWindowSize: num(options.endWindowSize ?? env.OPENCODE_VOICE2TEXT_END_WINDOW_SIZE ?? local.endWindowSize, DEFAULT_END_WINDOW_SIZE),
    maxDurationSeconds: num(options.maxDurationSeconds ?? env.OPENCODE_VOICE2TEXT_MAX_DURATION_SECONDS ?? local.maxDurationSeconds, 180),
    appendTrailingSpace: bool(options.appendTrailingSpace ?? env.OPENCODE_VOICE2TEXT_APPEND_TRAILING_SPACE ?? local.appendTrailingSpace, true),
    rate: num(options.rate ?? env.OPENCODE_VOICE2TEXT_SAMPLE_RATE ?? local.rate, DEFAULT_RATE),
    bits: num(options.bits ?? env.OPENCODE_VOICE2TEXT_BITS ?? local.bits, DEFAULT_BITS),
    channels: num(options.channels ?? env.OPENCODE_VOICE2TEXT_CHANNELS ?? local.channels, DEFAULT_CHANNELS),
    providerConfig: {
      ...localProviderConfig,
      ...buildProviderConfigOverrides(provider, local, options, env),
      ...optionProviderConfig,
    },
  }
}

export function createRuntimeConfig(baseConfig: Voice2TextConfig): Voice2TextRuntime {
  const provider = getProviderById(baseConfig.provider)
  return {
    provider,
    config: {
      ...baseConfig,
      providerConfig: provider.normalizeConfig(baseConfig.providerConfig),
    },
  }
}

function createRecorder(config: Voice2TextConfig, onChunk: (chunk: Buffer) => Promise<void> | void): RecorderSession {
  const command = recorderCommand()
  const args =
    process.platform === "win32"
      ? [
          "-q",
          "-t",
          "waveaudio",
          "default",
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
        ]
      : [
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
        ]

  const child = spawn(
    command,
    args,
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  )

  let stderr = ""
  let stopRequested = false
  let finished = false
  let streamError: Error | undefined
  let writeChain = Promise.resolve()
  let forceStopTimer: NodeJS.Timeout | undefined
  let forceKilled = false

  const requestStop = () => {
    if (finished) return

    if (!stopRequested) {
      stopRequested = true
      child.kill(process.platform === "win32" ? undefined : "SIGINT")
    }

    if (forceStopTimer) return
    forceStopTimer = setTimeout(() => {
      if (finished) return
      forceKilled = true
      child.kill(process.platform === "win32" ? undefined : "SIGKILL")
    }, RECORDER_FORCE_KILL_TIMEOUT_MS)
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    writeChain = writeChain.then(async () => {
      if (streamError) return
      try {
        await onChunk(chunk)
      } catch (error) {
        streamError = error instanceof Error ? error : new Error(String(error))
        requestStop()
      }
    })
  })

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const timer = setTimeout(() => {
    requestStop()
  }, config.maxDurationSeconds * 1000)

  const done = new Promise<void>((resolve, reject) => {
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (forceStopTimer) {
        clearTimeout(forceStopTimer)
        forceStopTimer = undefined
      }
      finished = true
      reject(error?.code === "ENOENT" ? new Error(installHint()) : error)
    })

    child.on("close", async (code, signal) => {
      clearTimeout(timer)
      if (forceStopTimer) {
        clearTimeout(forceStopTimer)
        forceStopTimer = undefined
      }
      finished = true
      await writeChain

      if (streamError) {
        reject(streamError)
        return
      }

      if (forceKilled) {
        reject(new Error("Recording did not stop cleanly."))
        return
      }

      if (code === 0 || signal === "SIGINT" || signal === "SIGTERM" || stopRequested) {
        resolve()
        return
      }

      reject(new Error(stderr.trim() || `Recording failed with code ${code ?? "unknown"}`))
    })
  })

  return {
    done,
    stop() {
      requestStop()
    },
  }
}

export async function startVoiceRecognition(
  config: Voice2TextConfig,
  provider: VoiceProvider,
  callbacks: RecognitionCallbacks,
): Promise<VoiceRecognitionRun> {
  await ensureRuntimeSupport()

  const configError = provider.validateConfig(config)
  if (configError) {
    throw new Error(configError)
  }

  const stream: RecognitionSession = await provider.createRecognition(config, callbacks)
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

  let stopResult: Promise<TranscriptResult> | undefined

  return {
    stop() {
      if (!stopResult) {
        stopResult = (async () => {
          session.recorder.stop()
          await session.recorder.done
          const finalChunk = session.pending.length > 0 ? session.pending : undefined
          return session.stream.finish(finalChunk)
        })()
      }
      return stopResult
    },
    async abort() {
      session.recorder.stop()
      await Promise.all([
        session.recorder.done.catch(() => undefined),
        session.stream.abort().catch(() => undefined),
      ])
    },
  }
}
