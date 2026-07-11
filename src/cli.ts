#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import {
  appendableText,
  createRuntimeConfig,
  defaultConfigPath,
  diffSuffix,
  loadConfig,
  startVoiceRecognition,
} from "./runtime.js"
import { listProviderIds } from "./providers/index.js"

const FINAL_TRANSCRIPT_TIMEOUT_MS = 30_000
const DEFAULT_TOGGLE_KEY = "ctrl+s"
const CTRL_C_SEQUENCE = "\u0003"
const CTRL_S_SEQUENCE = keySequence("ctrl+s")
const { name: CLI_PACKAGE_NAME, version: CLI_VERSION } = readPackageInfo()
const PROVIDER_HELP: Record<string, string> = {
  volcengine: "realtime websocket ASR with stable text while recording",
  mimo: "upload-after-stop ASR with one final transcript after stop (auto|zh|en)",
}

type CliOptions = Record<string, unknown> & {
  toggle?: boolean
  toggleKey?: string
}

type ParsedArgs = {
  command?: "update"
  error?: string
  options: CliOptions
  showHelp: boolean
  showVersion: boolean
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

function readPackageInfo() {
  try {
    const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name?: unknown; version?: unknown }
    return {
      name: typeof packageJson.name === "string" ? packageJson.name : "opencode-voice2text",
      version: typeof packageJson.version === "string" ? packageJson.version : "0.0.0",
    }
  } catch {
    return {
      name: "opencode-voice2text",
      version: "0.0.0",
    }
  }
}

function isOptionLike(value: string | undefined) {
  return typeof value === "string" && value.startsWith("-")
}

function missingValue(flag: string) {
  return `Missing value for ${flag}. Run 'voice2text --help' for usage.`
}

function unknownArgument(argument: string) {
  return `${argument.startsWith("-") ? "Unknown option" : "Unknown argument"} '${argument}'. Run 'voice2text --help' for usage.`
}

function unsupportedUpdateArgument(argument: string) {
  return `The update command does not accept '${argument}'. Run 'voice2text update' with no extra options.`
}

async function runSelfUpdate() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
  process.stdout.write(`Updating ${CLI_PACKAGE_NAME} from ${CLI_VERSION} with npm...\n`)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(npmCommand, ["install", "-g", `${CLI_PACKAGE_NAME}@latest`], {
      stdio: "inherit",
      windowsHide: true,
    })

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error?.code === "ENOENT") {
        reject(new Error(`Missing npm in PATH. Update manually with: npm install -g ${CLI_PACKAGE_NAME}@latest`))
        return
      }
      reject(error)
    })

    child.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`Update failed with exit code ${code ?? "unknown"}.`))
    })
  })

  process.stdout.write("Update complete. Run 'voice2text --version' to confirm the installed version.\n")
}

function parseArgs(argv: string[]): ParsedArgs {
  const options: CliOptions = {}
  let command: ParsedArgs["command"]
  let showHelp = false
  let showVersion = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]

    if (index === 0 && arg === "update") {
      command = "update"
      continue
    }

    if (command) {
      if (arg === "--help" || arg === "-h") {
        showHelp = true
        continue
      }

      if (arg === "--version" || arg === "-v") {
        showVersion = true
        continue
      }

      return { command, error: unsupportedUpdateArgument(arg), options, showHelp, showVersion }
    }

    if (arg === "--help" || arg === "-h") {
      showHelp = true
      continue
    }

    if (arg === "--version" || arg === "-v") {
      showVersion = true
      continue
    }

    if (arg === "--provider") {
      if (!next || isOptionLike(next)) {
        return { command, error: missingValue(arg), options, showHelp, showVersion }
      }
      options.provider = next
      index += 1
      continue
    }

    if (arg === "--language") {
      if (!next || isOptionLike(next)) {
        return { command, error: missingValue(arg), options, showHelp, showVersion }
      }
      options.language = next
      index += 1
      continue
    }

    if (arg === "--config") {
      if (!next || isOptionLike(next)) {
        return { command, error: missingValue(arg), options, showHelp, showVersion }
      }
      options.configPath = next
      index += 1
      continue
    }

    if (arg === "--max-duration") {
      if (!next || isOptionLike(next)) {
        return { command, error: missingValue(arg), options, showHelp, showVersion }
      }
      options.maxDurationSeconds = Number(next)
      index += 1
      continue
    }

    if (arg === "--toggle") {
      options.toggle = true
      continue
    }

    if (arg === "--toggle-key") {
      if (!next || isOptionLike(next)) {
        return { command, error: missingValue(arg), options, showHelp, showVersion }
      }
      options.toggle = true
      options.toggleKey = next
      index += 1
      continue
    }

    if (arg === "--no-trailing-space") {
      options.appendTrailingSpace = false
      continue
    }

    return { command, error: unknownArgument(arg), options, showHelp, showVersion }
  }

  return { command, options, showHelp, showVersion }
}

function printHelp() {
  const providers = listProviderIds()
    .map((providerId) => `  ${providerId.padEnd(10)} ${PROVIDER_HELP[providerId] ?? ""}`)
    .join("\n")

  process.stdout.write(`Usage:
  voice2text [options]
  voice2text update

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
  -v, --version            Show the installed CLI version
  -h, --help               Show this help

Commands:
  update                   Reinstall the latest published CLI with npm

Providers:
${providers}

Examples:
  voice2text
  voice2text --provider volcengine --language zh-CN
  voice2text --provider mimo --language auto
  voice2text --toggle
  voice2text --toggle --toggle-key ctrl+g
  voice2text --config ${displayPath(defaultConfigPath())}
  voice2text --version
  voice2text update

Stop recording with Ctrl+C, Ctrl+S, or Enter.

Notes:
  - Unknown options fail fast instead of starting voice recognition.
  - 'voice2text update' uses npm and may require global install permissions.
  - On macOS/Linux, Ctrl+S may be intercepted by terminal flow control. If it does nothing, run: stty -ixon
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

      if (!printedStableText) {
        writeStatus("\nTranscribing...\n")
      }
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
  let stopping = false
  let stdinListener: ((chunk: Buffer | string) => void) | undefined

  const cleanupInput = () => {
    if (!process.stdin.isTTY) return
    if (stdinListener) {
      process.stdin.off("data", stdinListener)
      stdinListener = undefined
    }
    if (process.stdin.isRaw) {
      process.stdin.setRawMode(false)
    }
    process.stdin.pause()
  }

  const finish = (stopPromise: Promise<void>) => {
    cleanupInput()
    void stopPromise
      .then(() => process.exit(0))
      .catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
        process.exit(1)
      })
  }

  const active = await createCliSession(config, provider, {
    onAutoStop: finish,
  })

  const stopAndExit = () => {
    if (stopping) {
      cleanupInput()
      process.exit(130)
    }
    stopping = true
    finish(active.stop())
  }

  process.once("SIGINT", stopAndExit)

  if (process.stdin.isTTY) {
    process.stdin.resume()
    process.stdin.setEncoding("utf8")

    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(true)
      stdinListener = (chunk) => {
        const input = chunk.toString()
        if (input === CTRL_C_SEQUENCE || input === CTRL_S_SEQUENCE || input === "\r" || input === "\n") {
          stopAndExit()
        }
      }
      process.stdin.on("data", stdinListener)
    } else {
      process.stdin.once("data", stopAndExit)
    }
  }

  writeStatus("Listening... press Ctrl+C, Ctrl+S, or Enter to stop.\n")
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
  const { command, error, options, showHelp, showVersion } = parseArgs(process.argv.slice(2))
  if (error) {
    process.stderr.write(`${error}\n`)
    process.exit(1)
  }

  if (showVersion) {
    process.stdout.write(`${CLI_VERSION}\n`)
    return
  }

  if (showHelp) {
    printHelp()
    return
  }

  if (command === "update") {
    await runSelfUpdate()
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
