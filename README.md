# opencode-voice2text

[中文文档](./README.zh-CN.md)

This is a streaming voice input plugin for the OpenCode TUI with a provider-based speech recognition architecture. The current built-in provider is Volcengine ASR.

Press the shortcut once to start recognition. While you speak naturally, audio is streamed continuously to Volcengine. Press the shortcut again to stop recognition. Stable recognized text is appended continuously into the current OpenCode input while you are still speaking.

## Demo

![demo](https://p9-xtjj-sign.byteimg.com/tos-cn-i-73owjymdk6/4179b924c4ab486f95a8f3c41c688e17~tplv-73owjymdk6-jj-mark-v1:0:0:0:0:5o6Y6YeR5oqA5pyv56S-5Yy6IEAgY2hlbnh1YW41MjA=:q75.awebp?rk3s=f64ab15b&x-expires=1776524057&x-signature=RGZz94OR%2F8wskiW2KswN9vLCtT4%3D)

## Features

- Start and stop streaming recognition with a single shortcut
- Stable recognition results are appended to the input before the session ends
- Warning/error toast feedback for misconfiguration or failures
- Works on macOS and Linux
- Keeps credentials out of the plugin repo

## Behavior

- First `Ctrl+S`: start microphone capture and streaming recognition
- While speaking: stable recognized text is appended continuously to the current prompt
- Second `Ctrl+S`: stop capture, wait for the final ASR result, then append the remaining tail text
- A persistent recording toast stays visible while recording and disappears automatically when recognition stops

## Why this is toggle-based

OpenCode's current TUI plugin API supports keybind matching, but it does not expose key release events yet. That means truly reliable "hold to record / release to stop" behavior is not possible in a plugin right now.

## Requirements

- OpenCode with TUI plugin support
- Provider credentials for your selected ASR backend
- Sox installed locally (`rec` on macOS/Linux, `sox.exe` on Windows)

macOS:

```bash
brew install sox
```

Ubuntu/Debian:

```bash
sudo apt install sox
```

Windows:

1. Download and install SoX from <https://sourceforge.net/projects/sox/>
2. Make sure `sox.exe` is available in `PATH`
3. Verify the install:

```powershell
sox --version
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

The installer writes a default TUI plugin entry for you with:

- `commandKeybind: "ctrl+s"`

You still need to make sure `terminal_suspend` does not conflict with your chosen shortcut.

Recommended `~/.config/opencode/tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "keybinds": {
    "terminal_suspend": "none"
  }
}
```

If you want a different shortcut, edit the generated plugin entry in `tui.json` after installation.

`Ctrl+S` is the default shortcut. If pressing it does nothing, your terminal is likely intercepting it for XON/XOFF flow control before OpenCode sees the key.

Current shell session fix:

```bash
stty -ixon
```

Persistent fix for zsh:

Add `stty -ixon` to `~/.zshrc`, then restart the terminal.

Persistent fix for bash:

Add `stty -ixon` to `~/.bashrc` or `~/.bash_profile`, then restart the terminal.

If you still prefer not to change terminal flow control, override `commandKeybind` manually in `tui.json`.

Windows terminals do not use the same `Ctrl+S` XON/XOFF flow control behavior, so the `stty -ixon` fix is only relevant on macOS/Linux shells.

## Restart OpenCode

If OpenCode is already running, restart it so the plugin and dependency tree are loaded again.

## Credentials

Create a local config file on the target machine:

macOS/Linux:

`~/.config/opencode/voice2text.local.json`

Windows:

`%APPDATA%\opencode\voice2text.local.json`

```json
{
  "provider": "volcengine",
  "providerConfig": {
    "appId": "your-volcengine-app-id",
    "accessToken": "your-volcengine-access-token",
    "resourceId": "volc.seedasr.sauc.duration",
    "endpoint": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
  },
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

## Volcengine setup

For the built-in `volcengine` provider, you need to prepare the following values from Volcengine before the plugin can work:

- Volcengine ASR product page: <https://www.volcengine.com/product/asr>

- `providerConfig.appId`
- `providerConfig.accessToken`
- `providerConfig.resourceId`
- `providerConfig.endpoint`

Typical setup flow:

1. Open the [Volcengine ASR page](https://www.volcengine.com/product/asr), sign in to the Volcengine console, or register first if you do not already have an account. Then open the speech recognition / ASR service page.
![image.png](https://img.011203.dpdns.org/file/1775972577499_image.png)

2. Create or select an application.
![image.png](https://img.011203.dpdns.org/file/1775972583608_image.png)

3. Get the credentials and resource settings for that application.
![image.png](https://img.011203.dpdns.org/file/1775972594458_image.png)

4. Fill the values into your local `voice2text.local.json`. On macOS/Linux the default path is `~/.config/opencode/voice2text.local.json`. On Windows the default path is `%APPDATA%\opencode\voice2text.local.json`. For `resourceId`, check the [Big Model Streaming Speech Recognition API docs](https://www.volcengine.com/docs/6561/1354869?lang=zh). The recommended value is `volc.seedasr.sauc.duration`. For `endpoint`, use `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async`.
![image.png](https://img.011203.dpdns.org/file/1775972606968_image.png)

For this plugin's current Volcengine implementation:

- `providerConfig.endpoint` is typically a websocket endpoint under `wss://openspeech.bytedance.com/api/v3/sauc/...`
- `providerConfig.resourceId` should match the model/resource you enabled in Volcengine
- `providerConfig.appId` and `providerConfig.accessToken` must belong to the same Volcengine application

Example:

```json
{
  "provider": "volcengine",
  "providerConfig": {
    "appId": "your-app-id",
    "accessToken": "your-access-token",
    "resourceId": "volc.seedasr.sauc.duration",
    "endpoint": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
  }
}
```

If the plugin is triggered without valid Volcengine credentials, it will show a warning toast instead of failing silently.

You can override the config path with:

```bash
export OPENCODE_VOICE2TEXT_LOCAL_CONFIG=/path/to/voice2text.local.json
```

## Environment variables

These can override or replace values from the local config file:

```bash
export OPENCODE_VOICE2TEXT_PROVIDER=volcengine
export OPENCODE_VOICE2TEXT_LANGUAGE=zh-CN
export OPENCODE_VOICE2TEXT_CHUNK_MS=200
export OPENCODE_VOICE2TEXT_END_WINDOW_SIZE=800
export OPENCODE_VOICE2TEXT_MAX_DURATION_SECONDS=180
export OPENCODE_VOICE2TEXT_APPEND_TRAILING_SPACE=true
export OPENCODE_VOICE2TEXT_SAMPLE_RATE=16000
export OPENCODE_VOICE2TEXT_BITS=16
export OPENCODE_VOICE2TEXT_CHANNELS=1
```

Legacy flat environment variables are still supported for the built-in Volcengine provider:

```bash
export OPENCODE_VOICE2TEXT_APP_ID=...
export OPENCODE_VOICE2TEXT_ACCESS_TOKEN=...
export OPENCODE_VOICE2TEXT_RESOURCE_ID=volc.seedasr.sauc.duration
export OPENCODE_VOICE2TEXT_ENDPOINT=wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
```

## Plugin options

You can pass the same runtime options through `tui.json`:

- `commandKeybind`
- `provider`
- `providerConfig`
- `language`
- `chunkMs`
- `endWindowSize`
- `maxDurationSeconds`
- `appendTrailingSpace`
- `rate`
- `bits`
- `channels`

In practice, credentials are best kept in the local config file or environment variables rather than in `tui.json`.

## Provider design

The config is now provider-oriented so more ASR backends can be added later without changing the install shape.

- current provider: `volcengine`
- future providers can reuse the same plugin entry and TUI behavior
- provider-specific secrets now live under `providerConfig`

To add a new provider in code:

1. add a new file under `src/providers/`
2. implement the `VoiceProvider` interface from `src/providers/types.ts`
3. register it in `src/providers/index.ts`
4. use `provider` + `providerConfig` in local config

If provider config is missing, pressing the shortcut shows a toast explaining which local config file to fill instead of failing silently.

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

- The built-in Volcengine provider uses Volcengine's websocket ASR protocol directly.
- Success toasts are intentionally not shown; recording state uses a long-lived toast that disappears after stop.
- Errors still surface as OpenCode toasts.
- `opencode plugin ...` updates the plugin entry in `tui.json`, but does not replace unrelated TUI settings such as `theme` or `keybinds`.
