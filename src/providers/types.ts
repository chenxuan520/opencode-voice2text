export type RecognitionCallbacks = {
  onStableText?: (text: string) => Promise<void>
}

export type TranscriptResult = {
  text: string
  stableText: string
  logId: string
}

export type RecognitionSession = {
  write: (chunk: Buffer) => void
  finish: (finalChunk?: Buffer) => Promise<TranscriptResult>
  abort: () => Promise<void>
}

export type Voice2TextConfig = {
  configPath: string
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
  providerConfig: Record<string, unknown>
}

export type VoiceProvider = {
  id: string
  displayName: string
  configFileFields: string[]
  normalizeConfig: (providerConfig: Record<string, unknown>) => Record<string, unknown>
  validateConfig: (config: Voice2TextConfig) => string | undefined
  createRecognition: (config: Voice2TextConfig, callbacks: RecognitionCallbacks) => Promise<RecognitionSession>
}
