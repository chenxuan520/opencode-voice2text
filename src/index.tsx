import "@opentui/solid/runtime-plugin-support"
/** @jsxImportSource @opentui/solid */
import { randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import tls from "node:tls"
import zlib from "node:zlib"
import { promises as fs } from "node:fs"
import { Show, createMemo } from "solid-js"
import type { PluginOptions } from "@opencode-ai/plugin"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"

const WS_OPCODE_BINARY = 0x2
const WS_OPCODE_CLOSE = 0x8
const WS_OPCODE_PING = 0x9
const WS_OPCODE_PONG = 0xA

const HEADER_VERSION = 0x1
const HEADER_SIZE = 0x1
const MESSAGE_TYPE_FULL_CLIENT_REQUEST = 0x1
const MESSAGE_TYPE_AUDIO_ONLY_REQUEST = 0x2
const MESSAGE_TYPE_ERROR = 0xF
const SERIALIZATION_NONE = 0x0
const SERIALIZATION_JSON = 0x1
const COMPRESSION_GZIP = 0x1

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config/opencode/voice2text.local.json")
const DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration"
const DEFAULT_CHUNK_MS = 200
const DEFAULT_RATE = 16000
const DEFAULT_BITS = 16
const DEFAULT_CHANNELS = 1
const DEFAULT_END_WINDOW_SIZE = 800

const STATUS_KEY = "opencode_voice2text.status"
const STATUS_MESSAGE_KEY = "opencode_voice2text.status_message"

type Voice2TextOptions = PluginOptions & {
  commandKeybind?: string
  provider?: string
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

type Voice2TextConfig = {
  commandKeybind: string
  provider: string
  language: string
  chunkMs: number
  endWindowSize: number
  maxDurationSeconds: number
  appendTrailingSpace: boolean
  rate: number
  bits: number
  channels: number
  providerConfig: {
    endpoint: string
    appId: string
    accessToken: string
    resourceId: string
  }
}

type VoiceProvider = {
  id: string
  displayName: string
  configFileFields: string[]
  validateConfig: (config: Voice2TextConfig) => string | undefined
  createRecognition: (
    config: Voice2TextConfig,
    callbacks: { onStableText?: (text: string) => Promise<void> },
  ) => Promise<RecognitionSession>
}

type TranscriptResult = {
  text: string
  stableText: string
  logId: string
}

type RecorderSession = {
  done: Promise<void>
  stop: () => void
}

type RecognitionSession = {
  write: (chunk: Buffer) => void
  finish: (finalChunk?: Buffer) => Promise<TranscriptResult>
  abort: () => Promise<void>
}

type VolcengineResponse = {
  flags: number
  data: any
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

function gzip(buffer: Buffer) {
  return zlib.gzipSync(buffer)
}

function buildProtocolHeader(messageType: number, flags: number, serialization: number, compression: number) {
  return Buffer.from([
    (HEADER_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ])
}

function buildClientMessage(messageType: number, flags: number, payload: Buffer, serialization: number) {
  const compressedPayload = gzip(payload)
  const header = buildProtocolHeader(messageType, flags, serialization, COMPRESSION_GZIP)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(compressedPayload.length, 0)
  return Buffer.concat([header, size, compressedPayload])
}

function buildEmptyLastAudioMessage() {
  const compressedPayload = gzip(Buffer.alloc(0))
  const header = buildProtocolHeader(MESSAGE_TYPE_AUDIO_ONLY_REQUEST, 0x2, SERIALIZATION_NONE, COMPRESSION_GZIP)
  const size = Buffer.alloc(4)
  size.writeUInt32BE(compressedPayload.length, 0)
  return Buffer.concat([header, size, compressedPayload])
}

function parseServerMessage(message: Buffer): VolcengineResponse {
  if (message.length < 8) throw new Error("Invalid Volcengine response frame")

  const headerSize = (message[0] & 0x0f) * 4
  const messageType = message[1] >> 4
  const flags = message[1] & 0x0f
  const serialization = message[2] >> 4
  const compression = message[2] & 0x0f
  let offset = headerSize

  if (messageType === MESSAGE_TYPE_ERROR) {
    const code = message.readUInt32BE(offset)
    offset += 4
    const payloadSize = message.readUInt32BE(offset)
    offset += 4
    const payload = message.subarray(offset, offset + payloadSize)
    const text = compression === COMPRESSION_GZIP ? zlib.gunzipSync(payload).toString("utf8") : payload.toString("utf8")
    throw new Error(`Volcengine ASR error ${code}: ${text}`)
  }

  if (flags === 0x1 || flags === 0x3) offset += 4
  const payloadSize = message.readUInt32BE(offset)
  offset += 4
  const payload = message.subarray(offset, offset + payloadSize)
  const body = compression === COMPRESSION_GZIP ? zlib.gunzipSync(payload) : payload

  return {
    flags,
    data: serialization === SERIALIZATION_JSON ? JSON.parse(body.toString("utf8")) : body,
  }
}

function createMaskedFrame(opcode: number, payload: Buffer) {
  const mask = randomBytes(4)
  const chunks = [Buffer.from([0x80 | opcode])]
  const length = payload.length

  if (length < 126) {
    chunks.push(Buffer.from([0x80 | length]))
  } else if (length <= 0xffff) {
    const extended = Buffer.alloc(3)
    extended[0] = 0x80 | 126
    extended.writeUInt16BE(length, 1)
    chunks.push(extended)
  } else {
    const extended = Buffer.alloc(9)
    extended[0] = 0x80 | 127
    extended.writeBigUInt64BE(BigInt(length), 1)
    chunks.push(extended)
  }

  const masked = Buffer.alloc(length)
  for (let index = 0; index < length; index += 1) {
    masked[index] = payload[index] ^ mask[index % 4]
  }

  chunks.push(mask, masked)
  return Buffer.concat(chunks)
}

class WebSocketBinaryClient {
  private readonly url: URL
  private readonly headers: Record<string, string>
  private socket: tls.TLSSocket | undefined
  private buffer = Buffer.alloc(0)
  private pendingFrames: Buffer[] = []
  private waiters: Array<{ resolve: (value: Buffer) => void; reject: (error: Error) => void }> = []

  constructor(url: string, headers: Record<string, string>) {
    this.url = new URL(url)
    this.headers = headers
  }

  async connect() {
    if (this.url.protocol !== "wss:") {
      throw new Error(`Unsupported websocket protocol: ${this.url.protocol}`)
    }

    const key = randomBytes(16).toString("base64")
    const headerLines = [
      `GET ${this.url.pathname}${this.url.search} HTTP/1.1`,
      `Host: ${this.url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
    ]

    for (const [name, value] of Object.entries(this.headers)) {
      headerLines.push(`${name}: ${value}`)
    }
    headerLines.push("\r\n")

    const socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
      const next = tls.connect({
        host: this.url.hostname,
        port: Number(this.url.port || 443),
        servername: this.url.hostname,
      })
      next.once("secureConnect", () => resolve(next))
      next.once("error", reject)
    })

    this.socket = socket
    socket.setNoDelay(true)
    socket.write(headerLines.join("\r\n"))

    const handshake = await new Promise<{ headerPart: string; rest: Buffer }>((resolve, reject) => {
      let chunkBuffer = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        chunkBuffer = Buffer.concat([chunkBuffer, chunk])
        const separator = chunkBuffer.indexOf("\r\n\r\n")
        if (separator === -1) return
        socket.off("data", onData)
        resolve({
          headerPart: chunkBuffer.subarray(0, separator).toString("utf8"),
          rest: chunkBuffer.subarray(separator + 4),
        })
      }
      socket.on("data", onData)
      socket.once("error", reject)
    })

    const lines = handshake.headerPart.split("\r\n")
    if (!(lines[0] || "").includes("101")) {
      throw new Error(`WebSocket handshake failed: ${lines[0] || "unknown"}`)
    }

    const responseHeaders: Record<string, string> = {}
    for (const line of lines.slice(1)) {
      const index = line.indexOf(":")
      if (index === -1) continue
      responseHeaders[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim()
    }

    socket.on("data", (chunk) => this.onData(chunk))
    socket.on("close", () => this.flushWaiters(new Error("WebSocket closed")))
    socket.on("error", (error) => this.flushWaiters(error))
    if (handshake.rest.length > 0) this.onData(handshake.rest)
    return responseHeaders
  }

  private onData(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk])

    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let offset = 2
      let payloadLength = second & 0x7f

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return
        payloadLength = this.buffer.readUInt16BE(offset)
        offset += 2
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return
        payloadLength = Number(this.buffer.readBigUInt64BE(offset))
        offset += 8
      }

      let mask: Buffer | undefined
      if (masked) {
        if (this.buffer.length < offset + 4) return
        mask = this.buffer.subarray(offset, offset + 4)
        offset += 4
      }

      if (this.buffer.length < offset + payloadLength) return

      let payload = this.buffer.subarray(offset, offset + payloadLength)
      this.buffer = this.buffer.subarray(offset + payloadLength)

      if (masked && mask) {
        const unmasked = Buffer.alloc(payload.length)
        for (let index = 0; index < payload.length; index += 1) {
          unmasked[index] = payload[index] ^ mask[index % 4]
        }
        payload = unmasked
      }

      if (opcode === WS_OPCODE_PING) {
        this.sendRaw(WS_OPCODE_PONG, payload)
        continue
      }

      if (opcode === WS_OPCODE_CLOSE) {
        this.flushWaiters(new Error("WebSocket closed by server"))
        return
      }

      if (opcode !== WS_OPCODE_BINARY) continue

      const waiter = this.waiters.shift()
      if (waiter) waiter.resolve(payload)
      else this.pendingFrames.push(payload)
    }
  }

  private flushWaiters(error: Error) {
    while (this.waiters.length > 0) {
      this.waiters.shift()?.reject(error)
    }
  }

  private sendRaw(opcode: number, payload: Buffer) {
    if (!this.socket) throw new Error("WebSocket is not connected")
    this.socket.write(createMaskedFrame(opcode, payload))
  }

  sendBinary(payload: Buffer) {
    this.sendRaw(WS_OPCODE_BINARY, payload)
  }

  async receiveBinary(timeoutMs = 30000) {
    if (this.pendingFrames.length > 0) {
      return this.pendingFrames.shift() as Buffer
    }

    return new Promise<Buffer>((resolve, reject) => {
      const waiter = {
        resolve: (value: Buffer) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (error: Error) => {
          clearTimeout(timer)
          reject(error)
        },
      }

      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((item) => item !== waiter)
        reject(new Error("Timed out waiting for Volcengine ASR response"))
      }, timeoutMs)

      this.waiters.push(waiter)
    })
  }

  async close() {
    if (!this.socket) return

    try {
      this.sendRaw(WS_OPCODE_CLOSE, Buffer.alloc(0))
    } catch {
      // Ignore close send failure.
    }

    const socket = this.socket
    await new Promise<void>((resolve) => {
      socket.end(() => resolve())
      setTimeout(() => resolve(), 200)
    })
    this.socket = undefined
  }
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

async function readLocalConfig() {
  const configPath = process.env.OPENCODE_VOICE2TEXT_LOCAL_CONFIG || DEFAULT_CONFIG_PATH
  try {
    return JSON.parse(await fs.readFile(configPath, "utf8")) as Record<string, unknown>
  } catch (error: any) {
    if (error?.code === "ENOENT") return {}
    throw error
  }
}

function configPathLabel() {
  return process.env.OPENCODE_VOICE2TEXT_LOCAL_CONFIG || DEFAULT_CONFIG_PATH
}

function providerName(provider: string) {
  if (provider === "volcengine") return "Volcengine ASR"
  return provider
}

async function loadConfig(options: Voice2TextOptions = {}): Promise<Voice2TextConfig> {
  const local = await readLocalConfig()
  const env = process.env
  const merged = { ...local, ...options }

  const config: Voice2TextConfig = {
    commandKeybind: str(merged.commandKeybind, "ctrl+g"),
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
      endpoint: str(merged.endpoint ?? env.OPENCODE_VOICE2TEXT_ENDPOINT, DEFAULT_ENDPOINT),
      appId: str(merged.appId ?? env.OPENCODE_VOICE2TEXT_APP_ID),
      accessToken: str(merged.accessToken ?? env.OPENCODE_VOICE2TEXT_ACCESS_TOKEN),
      resourceId: str(merged.resourceId ?? env.OPENCODE_VOICE2TEXT_RESOURCE_ID, DEFAULT_RESOURCE_ID),
    },
  }

  return config
}

const volcengineProvider: VoiceProvider = {
  id: "volcengine",
  displayName: "Volcengine ASR",
  configFileFields: ["provider", "appId", "accessToken", "resourceId", "endpoint"],
  validateConfig(config) {
    if (!config.providerConfig.appId || !config.providerConfig.accessToken || !config.providerConfig.resourceId) {
      return `Missing ${this.displayName} config. Fill ${configPathLabel()} with ${this.configFileFields.join(", ")}.`
    }
    return undefined
  },
  createRecognition(config, callbacks) {
    return createVolcengineRecognition(config, callbacks)
  },
}

const providers: Record<string, VoiceProvider> = {
  [volcengineProvider.id]: volcengineProvider,
}

function getProvider(config: Voice2TextConfig): VoiceProvider {
  const provider = providers[config.provider]
  if (!provider) {
    throw new Error(
      `Unsupported provider '${config.provider}'. Available providers: ${Object.keys(providers).join(", ")}.`,
    )
  }
  return provider
}

function buildVolcengineRequest(config: Voice2TextConfig) {
  const audio: Record<string, unknown> = {
    format: "pcm",
    codec: "raw",
    rate: config.rate,
    bits: config.bits,
    channel: config.channels,
  }

  if (config.language) {
    audio.language = config.language
  }

  return {
    user: {
      uid: os.userInfo().username,
      did: os.hostname(),
      platform: process.platform === "darwin" ? "macOS" : process.platform,
      sdk_version: "opencode-plugin",
      app_version: "opencode-voice2text",
    },
    audio,
    request: {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      result_type: "full",
      show_utterances: true,
      end_window_size: config.endWindowSize,
    },
  }
}

function getStableText(data: any) {
  const utterances = Array.isArray(data?.result?.utterances) ? data.result.utterances : []
  return utterances
    .filter((item: any) => item && item.definite && typeof item.text === "string" && item.text.trim())
    .map((item: any) => item.text)
    .join("")
    .trim()
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

async function createVolcengineRecognition(
  config: Voice2TextConfig,
  callbacks: { onStableText?: (text: string) => Promise<void> },
): Promise<RecognitionSession> {
  const client = new WebSocketBinaryClient(config.providerConfig.endpoint, {
    "X-Api-App-Key": config.providerConfig.appId,
    "X-Api-Access-Key": config.providerConfig.accessToken,
    "X-Api-Resource-Id": config.providerConfig.resourceId,
    "X-Api-Connect-Id": randomUUID(),
  })

  let lastText = ""
  let stableText = ""
  let closed = false

  const responseHeaders = await client.connect()
  const requestPayload = Buffer.from(JSON.stringify(buildVolcengineRequest(config)), "utf8")
  client.sendBinary(buildClientMessage(MESSAGE_TYPE_FULL_CLIENT_REQUEST, 0x0, requestPayload, SERIALIZATION_JSON))
  parseServerMessage(await client.receiveBinary())

  const receiveLoop = (async (): Promise<TranscriptResult> => {
    while (true) {
      const response = parseServerMessage(await client.receiveBinary(30000))
      const nextText = appendableText(response.data?.result?.text)
      if (nextText) lastText = nextText

      const nextStableText = appendableText(getStableText(response.data))
      const stableDelta = diffSuffix(stableText, nextStableText)
      if (stableDelta) {
        stableText = nextStableText
        await callbacks.onStableText?.(stableDelta)
      }

      if (response.flags === 0x3) {
        return {
          text: lastText,
          stableText,
          logId: responseHeaders["x-tt-logid"] || "",
        }
      }
    }
  })()

  let sendChain = Promise.resolve()

  return {
    write(chunk: Buffer) {
      if (closed || chunk.length === 0) return
      sendChain = sendChain.then(() => {
        client.sendBinary(buildClientMessage(MESSAGE_TYPE_AUDIO_ONLY_REQUEST, 0x0, chunk, SERIALIZATION_NONE))
      })
    },
    async finish(finalChunk?: Buffer) {
      if (closed) return receiveLoop
      closed = true

      if (finalChunk && finalChunk.length > 0) {
        sendChain = sendChain.then(() => {
          client.sendBinary(buildClientMessage(MESSAGE_TYPE_AUDIO_ONLY_REQUEST, 0x0, finalChunk, SERIALIZATION_NONE))
        })
      }

      await sendChain
      client.sendBinary(buildEmptyLastAudioMessage())

      try {
        return await receiveLoop
      } finally {
        await client.close()
      }
    },
    async abort() {
      if (closed) return
      closed = true
      await client.close()
    },
  }
}

async function appendTranscript(api: TuiPluginApi, config: Voice2TextConfig, text: string) {
  const nextText = config.appendTrailingSpace ? `${text} ` : text
  await api.client.tui.appendPrompt({ text: nextText })
}

function setStatus(api: TuiPluginApi, status: string, message: string) {
  api.kv.set(STATUS_KEY, status)
  api.kv.set(STATUS_MESSAGE_KEY, message)
}

function statusView(api: TuiPluginApi) {
  return () => {
    const status = createMemo(() => api.kv.get<string>(STATUS_KEY, "idle"))
    const message = createMemo(() => api.kv.get<string>(STATUS_MESSAGE_KEY, ""))
    const tone = createMemo(() => {
      if (status() === "recording") return api.theme.current.warning
      if (status() === "transcribing") return api.theme.current.accent
      return api.theme.current.textMuted
    })
    const label = createMemo(() => (status() === "recording" ? "REC" : "ASR"))

    return (
      <Show when={status() !== "idle"}>
        <box flexDirection="row" gap={1}>
          <text fg={tone()}>
            <b>{label()}</b>
          </text>
          <Show when={message()}>
            <text fg={api.theme.current.textMuted}>{message()}</text>
          </Show>
        </box>
      </Show>
    )
  }
}

const tui: TuiPlugin = async (api, options) => {
  const config = await loadConfig((options ?? {}) as Voice2TextOptions)
  const provider = getProvider(config)

  let phase: "idle" | "recording" | "transcribing" = "idle"
  let active:
    | {
        recorder: RecorderSession
        stream: RecognitionSession
        pending: Buffer
        chunkBytes: number
      }
    | undefined

  setStatus(api, "idle", "")

  api.slots.register({
    order: 50,
    slots: {
      home_prompt_right: statusView(api),
      session_prompt_right: statusView(api),
    },
  })

  const toast = (message: string, variant: "info" | "warning" | "error" = "info") => {
    api.ui.toast({ title: "Voice2Text", message, variant, duration: 2500 })
  }

  const startRecording = async () => {
    if (phase !== "idle") return

    phase = "recording"
    setStatus(api, "recording", `listening... press ${config.commandKeybind} to stop`)

    try {
      await ensureRuntimeSupport()

      const configError = provider.validateConfig(config)
      if (configError) {
        phase = "idle"
        setStatus(api, "idle", "")
        toast(configError, "warning")
        return
      }

      const stream = await provider.createRecognition(config, {
        onStableText: async (text) => {
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
      setStatus(api, "idle", "")
      toast(error instanceof Error ? error.message : String(error), "error")
    }
  }

  const stopRecording = async () => {
    if (phase !== "recording" || !active) return

    const current = active
    active = undefined
    phase = "transcribing"
    setStatus(api, "transcribing", "stopping...")

    try {
      current.recorder.stop()
      await current.recorder.done
      const finalChunk = current.pending.length > 0 ? current.pending : undefined
      const result = await current.stream.finish(finalChunk)
      const tail = diffSuffix(result.stableText, appendableText(result.text))

      if (tail) {
        await appendTranscript(api, config, tail)
      }

      void result.logId
    } catch (error) {
      await current.stream.abort().catch(() => undefined)
      toast(error instanceof Error ? error.message : String(error), "error")
    } finally {
      phase = "idle"
      setStatus(api, "idle", "")
    }
  }

  api.command.register(() => [
    {
      title: "Toggle voice input",
      value: "voice2text.toggle",
      description: `Stream microphone audio to ${providerName(config.provider)} and append recognized text to the prompt`,
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
    setStatus(api, "idle", "")
  })
}

const plugin: TuiPluginModule = {
  id: "opencode.voice2text",
  tui,
}

export default plugin
