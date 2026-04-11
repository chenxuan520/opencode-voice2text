# opencode-voice2text

Streaming voice input for the OpenCode TUI using Volcengine ASR.

Press a shortcut once to start recognition, speak naturally while audio streams to Volcengine, and press the shortcut again to stop. Stable text is appended into the current OpenCode prompt while you are still speaking.

## Features

- True start/stop streaming with a single shortcut
- Stable utterances appear in the prompt before the session ends
- Prompt-right status indicator while recording or finalizing
- Works on macOS and Linux
- Keeps credentials out of the plugin repo

## Behavior

- First `Ctrl+S`: start microphone capture and streaming recognition
- While speaking: stable recognized text is appended to the current prompt
- Second `Ctrl+S`: stop capture, flush the final ASR result, append the remaining tail text
- Idle state shows no persistent status UI

## Why this is toggle-based

OpenCode's current TUI plugin API exposes keybind matching, but not key release events. That means true press-and-hold / release-to-stop behavior is not reliable in a plugin today.

## Requirements

- OpenCode with TUI plugin support
- Volcengine ASR credentials
- `rec` from Sox installed locally

macOS:

```bash
brew install sox
```

Ubuntu/Debian:

```bash
sudo apt install sox
```

## Install

Preferred install command:

```bash
opencode plugin opencode-voice2text@latest --global
```

This is the same style used by `opencode-dynamic-context-pruning`. The OpenCode CLI installs the npm package and updates your OpenCode plugin config for you.

If you only want it in the current project instead of globally, omit `--global`:

```bash
opencode plugin opencode-voice2text@latest
```

## TUI config

OpenCode's plugin installer manages the server/plugin registration, but this plugin still needs a TUI keybind, so keep this in:

`~/.config/opencode/tui.json`

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": {
    "terminal_suspend": "none"
  },
  "plugin": [
    [
      "opencode-voice2text",
      {
        "commandKeybind": "ctrl+s"
      }
    ]
  ]
}
```

If you choose a different shortcut, make sure it does not conflict with an existing TUI keybind.

## Restart OpenCode

If OpenCode is already running, restart it so the plugin and dependency tree are loaded again.

## Credentials

Create a local config file on the target machine:

`~/.config/opencode/voice2text.local.json`

```json
{
  "appId": "your-volcengine-app-id",
  "accessToken": "your-volcengine-access-token",
  "resourceId": "volc.seedasr.sauc.duration",
  "endpoint": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async",
  "language": "zh-CN",
  "chunkMs": 200,
  "endWindowSize": 800,
  "maxDurationSeconds": 180,
  "appendTrailingSpace": true,
  "rate": 16000,
  "bits": 16,
  "channels": 1
}
```

An example template also lives in `examples/voice2text.local.example.json`.

You can override the config path with:

```bash
export OPENCODE_VOICE2TEXT_LOCAL_CONFIG=/path/to/voice2text.local.json
```

## Environment variables

These can override or replace values from the local config file:

```bash
export OPENCODE_VOICE2TEXT_APP_ID=...
export OPENCODE_VOICE2TEXT_ACCESS_TOKEN=...
export OPENCODE_VOICE2TEXT_RESOURCE_ID=volc.seedasr.sauc.duration
export OPENCODE_VOICE2TEXT_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
export OPENCODE_VOICE2TEXT_LANGUAGE=zh-CN
export OPENCODE_VOICE2TEXT_CHUNK_MS=200
export OPENCODE_VOICE2TEXT_END_WINDOW_SIZE=800
export OPENCODE_VOICE2TEXT_MAX_DURATION_SECONDS=180
export OPENCODE_VOICE2TEXT_APPEND_TRAILING_SPACE=true
export OPENCODE_VOICE2TEXT_SAMPLE_RATE=16000
export OPENCODE_VOICE2TEXT_BITS=16
export OPENCODE_VOICE2TEXT_CHANNELS=1
```

## Plugin options

You can pass the same runtime options through `tui.json`:

- `commandKeybind`
- `endpoint`
- `appId`
- `accessToken`
- `resourceId`
- `language`
- `chunkMs`
- `endWindowSize`
- `maxDurationSeconds`
- `appendTrailingSpace`
- `rate`
- `bits`
- `channels`

In practice, credentials are best kept in the local config file or environment variables rather than in `tui.json`.

## Development

Install dependencies and build:

```bash
npm install
npm run build
```

Type-check only:

```bash
npm run typecheck
```

## Publishing

### Automatic publish from GitHub Actions

This repository now includes `.github/workflows/publish.yml`.

It is configured for npm trusted publishing with GitHub Actions OIDC, so you do not need to store a long-lived `NPM_TOKEN` in GitHub.

Behavior:

- every push to `master` runs typecheck and build
- the workflow checks whether `package.json`'s current `name@version` already exists on npm
- if that version is not published yet, it runs `npm publish`
- if that version already exists, the workflow exits cleanly without failing

Required npm setup:

- add this repository as a trusted publisher for the npm package

On npmjs.com, open the package settings for `opencode-voice2text`, then configure:

- Trusted Publisher
- provider: GitHub Actions
- owner: `chenxuan520`
- repository: `opencode-voice2text`
- workflow filename: `publish.yml`

Important release rule:

- before pushing to `master`, bump `package.json` version if you want a new npm release
- if you push code without changing the version, CI will skip publishing because npm versions are immutable

Version bump examples:

```bash
npm version patch
```

or:

```bash
npm version minor
```

### Manual publish

```bash
npm publish
```

`prepublishOnly` runs the build automatically.

For emergency manual publishing, use your local npm login or a short-lived bypass-2FA token locally. Do not store long-lived publish tokens in GitHub Actions when trusted publishing is enabled.

## Notes

- The plugin uses Volcengine's websocket ASR protocol directly.
- Success toasts are intentionally not shown; ongoing state is visible near the prompt instead.
- Errors still surface as OpenCode toasts.
