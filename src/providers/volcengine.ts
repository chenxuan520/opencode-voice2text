import { randomBytes, randomUUID } from "node:crypto"
import os from "node:os"
import tls from "node:tls"
import zlib from "node:zlib"
import type {
  RecognitionCallbacks,
  RecognitionSession,
  TranscriptResult,
  Voice2TextConfig,
  VoiceProvider,
} from "./types.js"

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

const DEFAULT_ENDPOINT = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration"

type VolcengineResponse = {
  flags: number
  data: any
}

function str(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
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

async function createVolcengineRecognition(
  config: Voice2TextConfig,
  callbacks: RecognitionCallbacks,
): Promise<RecognitionSession> {
  const endpoint = str(config.providerConfig.endpoint, DEFAULT_ENDPOINT)
  const appId = str(config.providerConfig.appId)
  const accessToken = str(config.providerConfig.accessToken)
  const resourceId = str(config.providerConfig.resourceId, DEFAULT_RESOURCE_ID)

  const client = new WebSocketBinaryClient(endpoint, {
    "X-Api-App-Key": appId,
    "X-Api-Access-Key": accessToken,
    "X-Api-Resource-Id": resourceId,
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

export const volcengineProvider: VoiceProvider = {
  id: "volcengine",
  displayName: "Volcengine ASR",
  configFileFields: [
    "provider",
    "providerConfig.endpoint",
    "providerConfig.appId",
    "providerConfig.accessToken",
    "providerConfig.resourceId",
  ],
  normalizeConfig(providerConfig: Record<string, unknown>) {
    return {
      ...providerConfig,
      endpoint: str(providerConfig.endpoint, DEFAULT_ENDPOINT),
      resourceId: str(providerConfig.resourceId, DEFAULT_RESOURCE_ID),
    }
  },
  validateConfig(config: Voice2TextConfig) {
    if (!str(config.providerConfig.appId) || !str(config.providerConfig.accessToken) || !str(config.providerConfig.resourceId)) {
      return `Missing ${this.displayName} config. Fill ${config.configPath} with ${this.configFileFields.join(", ")}.`
    }
    return undefined
  },
  createRecognition(config: Voice2TextConfig, callbacks: RecognitionCallbacks) {
    return createVolcengineRecognition(config, callbacks)
  },
}
