import type {
  RecognitionCallbacks,
  RecognitionSession,
  TranscriptResult,
  Voice2TextConfig,
  VoiceProvider,
} from "./types.js"

const DEFAULT_ENDPOINT = "https://api.xiaomimimo.com/v1/chat/completions"
const DEFAULT_MODEL = "mimo-v2.5-asr"
const MAX_BASE64_AUDIO_CHARS = 10 * 1024 * 1024
const MIN_FINAL_TRANSCRIPT_TIMEOUT_MS = 90_000
const MAX_FINAL_TRANSCRIPT_TIMEOUT_MS = 300_000

function str(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback
}

function appendableText(text: unknown) {
  return typeof text === "string" ? text.trim() : ""
}

function normalizeEndpoint(value: unknown) {
  const endpoint = str(value, DEFAULT_ENDPOINT).replace(/\/+$/, "")
  return endpoint.endsWith("/v1") ? `${endpoint}/chat/completions` : endpoint
}

function normalizeLanguage(language: string) {
  const normalized = str(language).toLowerCase()
  if (!normalized || normalized === "auto") return "auto"
  if (normalized.startsWith("zh")) return "zh"
  if (normalized.startsWith("en")) return "en"
  return normalized
}

function getFinalTranscriptTimeoutMs(config: Voice2TextConfig) {
  return Math.max(
    MIN_FINAL_TRANSCRIPT_TIMEOUT_MS,
    Math.min(MAX_FINAL_TRANSCRIPT_TIMEOUT_MS, config.maxDurationSeconds * 1000),
  )
}

function wavHeader(config: Voice2TextConfig, pcmSize: number) {
  const bytesPerSample = Math.max(1, Math.floor(config.bits / 8))
  const blockAlign = config.channels * bytesPerSample
  const byteRate = config.rate * blockAlign
  const header = Buffer.alloc(44)

  header.write("RIFF", 0, "ascii")
  header.writeUInt32LE(36 + pcmSize, 4)
  header.write("WAVE", 8, "ascii")
  header.write("fmt ", 12, "ascii")
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(config.channels, 22)
  header.writeUInt32LE(config.rate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(config.bits, 34)
  header.write("data", 36, "ascii")
  header.writeUInt32LE(pcmSize, 40)

  return header
}

function buildWav(config: Voice2TextConfig, pcm: Buffer) {
  return Buffer.concat([wavHeader(config, pcm.length), pcm])
}

function extractMessageText(content: any): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  return content
    .map((item) => {
      if (typeof item === "string") return item
      if (typeof item?.text === "string") return item.text
      if (typeof item?.content === "string") return item.content
      return ""
    })
    .join("")
}

function extractResponseText(body: any) {
  const messageText = appendableText(body?.choices?.[0]?.message?.content)
  if (messageText) return messageText

  const richMessageText = appendableText(extractMessageText(body?.choices?.[0]?.message?.content))
  if (richMessageText) return richMessageText

  const directText = appendableText(body?.text)
  if (directText) return directText

  return ""
}

function extractErrorMessage(body: any) {
  const candidates = [
    body?.error?.message,
    body?.error?.details,
    body?.message,
    body?.detail,
  ]

  for (const candidate of candidates) {
    const text = appendableText(candidate)
    if (text) return text
  }

  return ""
}

async function parseJsonResponse(response: Response) {
  const raw = await response.text()
  if (!raw.trim()) return { raw, body: {} }

  try {
    return {
      raw,
      body: JSON.parse(raw),
    }
  } catch {
    return {
      raw,
      body: undefined,
    }
  }
}

async function createMimoRecognition(
  config: Voice2TextConfig,
  _callbacks: RecognitionCallbacks,
): Promise<RecognitionSession> {
  const endpoint = normalizeEndpoint(config.providerConfig.endpoint)
  const apiKey = str(config.providerConfig.apiKey)
  const model = str(config.providerConfig.model, DEFAULT_MODEL)
  const language = normalizeLanguage(config.language)

  const chunks: Buffer[] = []
  let totalBytes = 0
  let closed = false
  let abortController: AbortController | undefined
  let abortReason: "timeout" | "cancelled" | undefined
  let finishResult: Promise<TranscriptResult> | undefined

  return {
    write(chunk: Buffer) {
      if (closed || chunk.length === 0) return
      chunks.push(Buffer.from(chunk))
      totalBytes += chunk.length
    },
    finish(finalChunk?: Buffer) {
      if (!finishResult) {
        finishResult = (async () => {
          closed = true

          if (finalChunk && finalChunk.length > 0) {
            chunks.push(Buffer.from(finalChunk))
            totalBytes += finalChunk.length
          }

          if (totalBytes === 0) {
            return {
              text: "",
              stableText: "",
              logId: "",
            }
          }

          const wav = buildWav(config, Buffer.concat(chunks, totalBytes))
          const audioBase64 = wav.toString("base64")
          if (audioBase64.length > MAX_BASE64_AUDIO_CHARS) {
            throw new Error("Xiaomi MiMo ASR supports up to 10MB base64 audio payloads. Shorten the recording or lower the audio settings.")
          }

          abortController = new AbortController()
          const requestTimeout = setTimeout(() => {
            abortReason = "timeout"
            abortController?.abort()
          }, getFinalTranscriptTimeoutMs(config))

          try {
            const response = await fetch(endpoint, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "api-key": apiKey,
              },
              body: JSON.stringify({
                model,
                messages: [
                  {
                    role: "user",
                    content: [
                      {
                        type: "input_audio",
                        input_audio: {
                          data: `data:audio/wav;base64,${audioBase64}`,
                        },
                      },
                    ],
                  },
                ],
                asr_options: {
                  language,
                },
              }),
              signal: abortController.signal,
            })

            const { raw, body } = await parseJsonResponse(response)
            if (!response.ok) {
              throw new Error(
                `Xiaomi MiMo ASR error ${response.status}: ${extractErrorMessage(body) || raw || response.statusText}`,
              )
            }

            if (!body) {
              throw new Error(`Invalid Xiaomi MiMo ASR response: ${raw}`)
            }

            const text = extractResponseText(body)
            if (!text) {
              throw new Error("Xiaomi MiMo ASR returned an empty transcript.")
            }

            return {
              text,
              stableText: "",
              logId: response.headers.get("x-request-id") || response.headers.get("request-id") || "",
            }
          } catch (error: any) {
            if (error?.name === "AbortError") {
              if (abortReason === "timeout") {
                throw new Error("Timed out waiting for Xiaomi MiMo ASR response.")
              }
              throw new Error("Xiaomi MiMo ASR request aborted.")
            }

            throw error instanceof Error ? error : new Error(String(error))
          } finally {
            clearTimeout(requestTimeout)
            abortController = undefined
            abortReason = undefined
            chunks.length = 0
            totalBytes = 0
          }
        })()
      }

      return finishResult
    },
    async abort() {
      closed = true
      chunks.length = 0
      totalBytes = 0
      abortReason = "cancelled"
      abortController?.abort()
    },
  }
}

export const mimoProvider: VoiceProvider = {
  id: "mimo",
  displayName: "Xiaomi MiMo ASR",
  configFileFields: [
    "provider",
    "providerConfig.apiKey",
    "providerConfig.model",
    "providerConfig.endpoint",
  ],
  normalizeConfig(providerConfig: Record<string, unknown>) {
    return {
      ...providerConfig,
      endpoint: normalizeEndpoint(providerConfig.endpoint),
      model: str(providerConfig.model, DEFAULT_MODEL),
    }
  },
  validateConfig(config: Voice2TextConfig) {
    if (!str(config.providerConfig.apiKey)) {
      return `Missing ${this.displayName} config. Fill ${config.configPath} with ${this.configFileFields.join(", ")} or nest them under providerConfig.mimo.`
    }

    const language = normalizeLanguage(config.language)
    if (language !== "auto" && language !== "zh" && language !== "en") {
      return `${this.displayName} only supports language values auto, zh, or en. Current value: ${config.language || "(empty)"}.`
    }

    return undefined
  },
  getFinalTranscriptTimeoutMs,
  createRecognition(config: Voice2TextConfig, callbacks: RecognitionCallbacks) {
    return createMimoRecognition(config, callbacks)
  },
}
