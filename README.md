# opencode-voice2text

[中文文档](./README.zh-CN.md)

This is a provider-based speech recognition tool that can run as an OpenCode TUI plugin or as a standalone terminal command. The current built-in providers are Volcengine ASR and Xiaomi MiMo ASR.

Press the shortcut once to start recognition. Audio is always captured locally from the microphone, then each provider handles it according to its API. Volcengine appends stable text while you are still speaking. Xiaomi MiMo uploads the recorded audio as a WAV file after you stop, then appends the final transcript.

## Demo

![demo](http://cdn.androidftp.top/test/202605516135051m6ecth.url)

## Features

- Start and stop voice recognition with a single shortcut
- Run directly in macOS/Linux terminals and print recognized text to stdout
- Support both realtime and upload-after-stop ASR providers
- Warning/error toast feedback for misconfiguration or failures
- Works on macOS and Linux
- Keeps credentials out of the plugin repo

## Behavior

- First `Ctrl+S`: start microphone capture and recognition
- While speaking: providers with realtime partials append stable recognized text continuously to the current prompt
- Second `Ctrl+S`: stop capture, wait for the provider's final result, then append the remaining tail text
- V1 and V2 use the global persistent recording toast. V2 also shows removable recording/transcription status in the prompt footer. Toast updates follow the host's normal hover and queue behavior.

## Why this is toggle-based

OpenCode's current TUI plugin API supports keybind matching, but it does not expose key release events yet. That means truly reliable "hold to record / release to stop" behavior is not possible in a plugin right now.

## Requirements

- OpenCode with TUI plugin support when using the TUI plugin entry
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

### OpenCode V1 plugin

Preferred install command:

```bash
opencode plugin opencode-voice2text@latest --global
```

This is the same style used by `opencode-dynamic-context-pruning`. The OpenCode CLI installs the npm package and updates your OpenCode plugin config for you.

If you only want it in the current project instead of globally, omit `--global`:

```bash
opencode plugin opencode-voice2text@latest
```

### Standalone CLI

For direct terminal use on macOS/Linux, make sure Node.js/npm is available, then install the same package as a global npm command:

```bash
npm install -g opencode-voice2text
voice2text
```

Or run it without a global install:

```bash
npx opencode-voice2text
```

The npm package name remains `opencode-voice2text`; the installed executable command is `voice2text`.

The OpenCode plugin install and the standalone CLI install are separate entry points. Use the OpenCode command when you want the TUI plugin, and use the npm command when you want a normal terminal command.

## Terminal CLI

By default, the command starts recording immediately, sends microphone audio to the configured provider, and prints recognition text to stdout as it arrives. Realtime providers print stable text during recording. Upload-after-stop providers print once the final transcript is ready. Stop recording with `Ctrl+C`, `Ctrl+S`, or Enter. When recording stops, the command waits for the final ASR result, prints any remaining tail text, and exits.

`Ctrl+S` in the one-shot CLI depends on the terminal forwarding that key to the process. If your terminal uses XON/XOFF flow control, `Ctrl+C` remains the reliable fallback unless you disable flow control with `stty -ixon`.

Run `voice2text --help` for the full option list, examples, and provider notes. Use `voice2text --version` to check the installed CLI version. Unknown options now fail fast instead of starting voice recognition.

To self-update the CLI from npm, run `voice2text update`. It reinstalls the latest published version with `npm install -g opencode-voice2text@latest`.

For a reusable hotkey-driven CLI session, use toggle mode:

```bash
voice2text --toggle
```

In toggle mode:

- press `Ctrl+S` once to start recording
- press `Ctrl+S` again to stop and flush the final result
- repeat for another utterance
- press `Ctrl+C` to exit

You can choose another toggle key:

```bash
voice2text --toggle --toggle-key ctrl+g
```

On macOS/Linux, `Ctrl+S` may be intercepted by terminal flow control before the CLI receives it. If the toggle key does nothing, run:

```bash
stty -ixon
```

Useful options:

```bash
voice2text --config ~/.config/opencode/voice2text.local.json
voice2text --language zh-CN
voice2text --max-duration 10
voice2text --provider mimo
voice2text --toggle --toggle-key ctrl+s
voice2text --no-trailing-space
voice2text --version
voice2text update
```

The CLI and OpenCode plugin use the same local config file and `OPENCODE_VOICE2TEXT_*` environment variables, so you only need to create credentials once.

## TUI config

### OpenCode V2

Version `0.1.22` adds a native v2 `setup(context)` entry alongside the existing v1 `tui(api)` entry. The plugin has been validated with OpenCode `2.2.5` and `2.3.2`, while retaining v1 and standalone CLI support.

After installing the release, configure the global v2 `cli.json` as below. For a source checkout, run `npm run build` and replace the package name with its directory, not `dist/index.js` (v2 discovers the `./tui` export):

```json
{
  "plugins": [
    {
      "package": "opencode-voice2text@0.1.22",
      "options": {
        "commandKeybind": "ctrl+s",
        "configPath": "/absolute/path/to/test-voice2text.local.json"
      }
    }
  ]
}
```

V2 uses `plugins` and `{ package, options }`, not the v1 `plugin` tuple format. Do not copy the v1 `terminal_suspend` setting below into a v2 config. Provider configuration and credentials keep their existing format; for testing, use only a local fake recorder and ASR endpoint. A running host must reload the plugin or be restarted by its operator to load changed code.

- Command palette: **Toggle voice input**; slash commands: `/voice2text` and `/voice`.
- Default shortcut: `Ctrl+S`; `commandKeybind: "ctrl+g"` selects `Ctrl+G` instead. On macOS/Linux, `stty -ixon` resolves terminal flow-control interception.
- The first shortcut shows `Listening...` in the global toast and `Voice2Text: Listening...` in the prompt footer. The next stops capture and changes both to `Transcribing...`, then appends only the final transcript tail. While waiting, one more shortcut warns and the following shortcut cancels. The footer is removed on completion/cancellation; toast updates and clearing follow the global queue and can be delayed by hover or earlier messages. Short warnings and errors also use normal toasts.
- Realtime text is appended to the current visible composer without replacing existing text or attachments. V2 inserts at the end of the live editor, including text typed during recognition.
- Pressing again during startup cancels startup. Switching sessions or replacing/destroying the composer cancels the run; plugin cleanup aborts it. Previously appended stable text remains, but late results are discarded. Route/composer changes are checked every 50 ms while active and synchronously before every append.

V2.2.5 has no public `ui.prompt` API or client `tui.appendPrompt`. The narrow adapter uses the host renderer's visible editor marked `owner: "opencode", role: "prompt"` and OpenTUI 0.8.0 `clearSelection()` / `gotoBufferEnd()` / `insertText()`. This composer integration is version-specific and must be rechecked when upgrading OpenCode; it never submits a prompt or broadcasts an append through the server.

API evidence, pinned to [v2.2.5 (`9bbb8ce`)](https://github.com/anomalyco/opencode/tree/9bbb8ce18c80f099e0e448775f59d965ead40a21):

- [`plugin/src/tui/context.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/tui/context.ts): `ui.toast.show`, `ui.slot`, `keymap.layer`, `ui.router.current`, and `renderer`; [`plugin.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/tui/plugin.ts): setup returns cleanup.
- [`tui/src/prompt/traits.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/tui/src/prompt/traits.ts) and [`component/prompt/index.tsx`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/tui/src/component/prompt/index.tsx): composer identity and `onContentChange` synchronization of text and attachment extmarks.
- [`plugin/src/host.ts`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/plugin/src/host.ts) and [`tui/src/config/index.tsx`](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/tui/src/config/index.tsx): package-directory `./tui` resolution and v2 configuration.
- OpenTUI 0.8.0 [`Renderable`](https://unpkg.com/@opentui/core@0.8.0/Renderable.d.ts) and [`EditBufferRenderable`](https://unpkg.com/@opentui/core@0.8.0/renderables/EditBufferRenderable.d.ts): tree traversal, visibility, destruction, and editor mutation contracts.

`npm test` builds and runs Node behavior tests with fake ASR/audio against both plugin entries, plus runtime cancellation and standalone CLI regressions. It requires Node's `--experimental-test-module-mocks` support (tested with Node 25.8.2); it does not record audio or contact ASR services. These tests do not substitute for native TUI checks: verify palette/slash/key dispatch, text plus attachment preservation, recording status and error toasts, session switching, and disable/reload during startup/recording/transcription in the real host, followed by independent review. See [native test instructions](./tests/README.md).

### OpenCode v1

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

Create a local config file on the target machine. The CLI and OpenCode plugin share this same file by default:

The default config path does not change when you switch providers.

The same file can also hold credentials for multiple providers at once. The top-level `provider` field decides which provider is active.

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

Example templates also live in `examples/voice2text.local.example.json` for Volcengine and `examples/voice2text.mimo.local.example.json` for Xiaomi MiMo.

If you want one config file to keep both providers ready, use a nested `providerConfig` shape keyed by provider id:

```json
{
  "provider": "volcengine",
  "providerConfig": {
    "volcengine": {
      "appId": "your-volcengine-app-id",
      "accessToken": "your-volcengine-access-token",
      "resourceId": "volc.seedasr.sauc.duration",
      "endpoint": "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async"
    },
    "mimo": {
      "apiKey": "your-mimo-api-key",
      "model": "mimo-v2.5-asr",
      "endpoint": "https://api.xiaomimimo.com/v1/chat/completions"
    }
  },
  "language": "zh"
}
```

This multi-provider example also lives in `examples/voice2text.multi-provider.local.example.json`.

## Volcengine setup

For the built-in `volcengine` provider, you need to prepare the following values from Volcengine before the plugin can work:

- Volcengine ASR product page: <https://www.volcengine.com/product/asr>

- single-provider config: `providerConfig.appId`, `providerConfig.accessToken`, `providerConfig.resourceId`, `providerConfig.endpoint`
- multi-provider config: `providerConfig.volcengine.appId`, `providerConfig.volcengine.accessToken`, `providerConfig.volcengine.resourceId`, `providerConfig.volcengine.endpoint`

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

## Xiaomi MiMo setup

For the built-in `mimo` provider, prepare the following values from Xiaomi MiMo before using the plugin:

- Xiaomi MiMo ASR docs: <https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/Speech-Recognition>
- single-provider config: `providerConfig.apiKey`, `providerConfig.model`, `providerConfig.endpoint`
- multi-provider config: `providerConfig.mimo.apiKey`, `providerConfig.mimo.model`, `providerConfig.mimo.endpoint`

Current MiMo provider behavior:

- microphone audio is captured locally the same way as Volcengine
- when recording stops, the plugin wraps the recorded PCM as a WAV file and uploads it to MiMo
- MiMo does not append text while you are still speaking; text is appended after the upload finishes
- `language` should be `auto`, `zh`, or `en`; values such as `zh-CN` and `en-US` are normalized automatically

Example:

```json
{
  "provider": "mimo",
  "providerConfig": {
    "apiKey": "your-mimo-api-key",
    "model": "mimo-v2.5-asr",
    "endpoint": "https://api.xiaomimimo.com/v1/chat/completions"
  },
  "language": "zh"
}
```

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

If you are using Xiaomi MiMo, these provider-specific environment variables are also supported:

```bash
export OPENCODE_VOICE2TEXT_PROVIDER=mimo
export OPENCODE_VOICE2TEXT_MIMO_API_KEY=...
export OPENCODE_VOICE2TEXT_MIMO_MODEL=mimo-v2.5-asr
export OPENCODE_VOICE2TEXT_MIMO_ENDPOINT=https://api.xiaomimimo.com/v1/chat/completions
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

- current providers: `volcengine`, `mimo`
- future providers can reuse the same plugin entry and TUI behavior
- provider-specific secrets now live under `providerConfig`
- single-provider configs can keep using a flat `providerConfig`
- multi-provider configs can nest credentials under `providerConfig.<providerId>` and switch with the top-level `provider`

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
- Success toasts are intentionally not shown; both versions use the existing long-lived recording toast, and V2 additionally uses a removable prompt-footer status.
- Errors still surface as OpenCode toasts.
- `opencode plugin ...` updates the plugin entry in `tui.json`, but does not replace unrelated TUI settings such as `theme` or `keybinds`.
