#!/usr/bin/env node
import {
  appendableText,
  createRuntimeConfig,
  defaultConfigPath,
  diffSuffix,
  loadConfig,
  startVoiceRecognition,
} from "./runtime.js"

const FINAL_TRANSCRIPT_TIMEOUT_MS = 30_000
const DEFAULT_TOGGLE_KEY = "ctrl+s"

type CliOptions = Record<string, unknown> & {
  toggle?: boolean
  toggleKey?: string
}

type ActiveCliSession = {
  stop: () => Promise<void>
  abort: () => Promise<void>
}

type CliSessionOptions = {
  onAutoStop?: (stopPromise: Promise<void>) => void
}

function displayPath(filePath: string) {
  const home = process.env.HOME
  if (home && filePath.startsWith(home)) {
    return `~${filePath.slice(home.length)}`
  }
  return filePath
}

function writeStdout(text: string) {
  if (!text) return
  process.stdout.write(text)
}

function writeStatus(text: string) {
  if (!process.stderr.isTTY) return
  process.stderr.write(text)
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

function normalizeKey(value: string) {
  return value.trim().toLowerCase()
}

function keySequence(key: string) {
  const normalized = normalizeKey(key)
  if (/^ctrl\+[a-z]$/.test(normalized)) {
    return String.fromCharCode(normalized.charCodeAt(normalized.length - 1) - 96)
  }
  if (normalized === "enter" || normalized === "return") return "\r"
  if (normalized === "space") return " "
  return key
}

function parseArgs(argv: string[]) {
  const options: CliOptions = {}
  let showHelp = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    if (arg === "--help" || arg === "-h") {
      showHelp = true
      continue
    }

    if (arg === "--provider" && next) {
      options.provider = next
      index += 1
      continue
    }

    if (arg === "--language" && next) {
      options.language = next
      index += 1
      continue
    }

    if (arg === "--config" && next) {
      options.configPath = next
      index += 1
      continue
    }

    if (arg === "--max-duration" && next) {
      options.maxDurationSeconds = Number(next)
      index += 1
      continue
    }

    if (arg === "--toggle") {
      options.toggle = true
      continue
    }

    if (arg === "--toggle-key" && next) {
      options.toggle = true
      options.toggleKey = next
      index += 1
      continue
    }

    if (arg === "--no-trailing-space") {
      options.appendTrailingSpace = false
    }
  }

  return { options, showHelp }
}

function printHelp() {
  process.stdout.write(`Usage: voice2text [options]

Record microphone audio, send it to the configured ASR provider, and print recognized text to stdout.

Default config:
  ${displayPath(defaultConfigPath())}

Options:
  --config <path>          Use a custom local config file
  --provider <id>          Override the ASR provider
  --language <locale>      Override recognition language, for example zh-CN
  --max-duration <seconds> Stop recording automatically after this duration
  --toggle                 Wait for a hotkey and toggle recording on/off
  --toggle-key <key>       Hotkey for toggle mode, default ctrl+s
  --no-trailing-space      Do not append a trailing space after recognized text
  -h, --help               Show this help

Stop recording with Ctrl+C or Enter.
`)
}

async function createCliSession(
  config: ReturnType<typeof createRuntimeConfig>["config"],
  provider: ReturnType<typeof createRuntimeConfig>["provider"],
  sessionOptions: CliSessionOptions = {},
): Promise<ActiveCliSession> {
  let printedStableText = ""
  let stopping: Promise<void> | undefined
  let stopTimer: NodeJS.Timeout | undefined

  const run = await startVoiceRecognition(config, provider, {
    onStableText: async (text) => {
      const next = appendableText(text)
      if (!next) return
      printedStableText += next
      writeStdout(config.appendTrailingSpace ? `${next} ` : next)
    },
  })

  const stop = async () => {
    if (stopping) return stopping
    stopping = (async () => {
      if (stopTimer) {
        clearTimeout(stopTimer)
        stopTimer = undefined
      }

      writeStatus("\nTranscribing...\n")
      try {
        const result = await withTimeout(
          run.stop(),
          provider.getFinalTranscriptTimeoutMs?.(config) ?? FINAL_TRANSCRIPT_TIMEOUT_MS,
          "Timed out waiting for final transcript from the ASR provider.",
        )
        const tail = diffSuffix(result.stableText, appendableText(result.text))

        if (tail) {
          printedStableText += tail
          writeStdout(config.appendTrailingSpace ? `${tail} ` : tail)
        }

        if (printedStableText && process.stdout.isTTY) {
          process.stdout.write("\n")
        }
      } catch (error) {
        await run.abort().catch(() => undefined)
        throw error
      }
    })()
    return stopping
  }

  stopTimer = setTimeout(() => {
    const stopPromise = stop()
    if (sessionOptions.onAutoStop) {
      sessionOptions.onAutoStop(stopPromise)
      return
    }

    void stopPromise
      .then(() => process.exit(0))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exit(1)
      })
  }, config.maxDurationSeconds * 1000)

  return {
    stop,
    async abort() {
      if (stopTimer) {
        clearTimeout(stopTimer)
        stopTimer = undefined
      }
      await run.abort().catch(() => undefined)
    },
  }
}

async function runOnce(config: ReturnType<typeof createRuntimeConfig>["config"], provider: ReturnType<typeof createRuntimeConfig>["provider"]) {
  const active = await createCliSession(config, provider)

  process.once("SIGINT", () => {
    void active.stop()
      .then(() => process.exit(0))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exit(1)
      })
  })

  if (process.stdin.isTTY) {
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    process.stdin.once("data", () => {
      void active.stop()
        .then(() => process.exit(0))
        .catch((error) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
          process.exit(1)
        })
    })
  }

  writeStatus("Listening... press Ctrl+C or Enter to stop.\n")
}

async function runToggle(config: ReturnType<typeof createRuntimeConfig>["config"], provider: ReturnType<typeof createRuntimeConfig>["provider"], toggleKey: string) {
  if (!process.stdin.isTTY) {
    throw new Error("Toggle mode requires an interactive TTY.")
  }

  const sequence = keySequence(toggleKey)
  let active: ActiveCliSession | undefined
  let busy = false

  const cleanup = async () => {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    await active?.abort().catch(() => undefined)
  }

  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding("utf8")
  writeStatus(`Ready. Press ${toggleKey} to start/stop recording, Ctrl+C to exit.\n`)

  process.stdin.on("data", (chunk) => {
    const input = chunk.toString()
    if (input === "\u0003") {
      void cleanup().finally(() => process.exit(0))
      return
    }

    if (input !== sequence || busy) return
    busy = true

    if (!active) {
      writeStatus("Listening...\n")
      void createCliSession(config, provider, {
        onAutoStop: (stopPromise) => {
          void stopPromise
            .catch((error) => {
              process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
            })
            .finally(() => {
              active = undefined
              busy = false
              writeStatus(`Ready. Press ${toggleKey} to start/stop recording, Ctrl+C to exit.\n`)
            })
        },
      })
        .then((session) => {
          active = session
        })
        .catch((error) => {
          process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        })
        .finally(() => {
          busy = false
        })
      return
    }

    const current = active
    active = undefined
    void current.stop()
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      })
      .finally(() => {
        busy = false
        writeStatus(`Ready. Press ${toggleKey} to start/stop recording, Ctrl+C to exit.\n`)
      })
  })
}

async function main() {
  const { options, showHelp } = parseArgs(process.argv.slice(2))
  if (showHelp) {
    printHelp()
    return
  }

  const baseConfig = await loadConfig(options)
  const { config, provider } = createRuntimeConfig(baseConfig)

  if (options.toggle) {
    await runToggle(config, provider, typeof options.toggleKey === "string" ? options.toggleKey : DEFAULT_TOGGLE_KEY)
    return
  }

  await runOnce(config, provider)
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
