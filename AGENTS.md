# opencode-voice2text Repo Guide

## Repo purpose

This repository contains a standalone, shareable OpenCode TUI plugin published as an npm package.

It is not an OpenCode workspace repo and not an application. Treat it as a distributable plugin package.

## Source of truth

- Source code lives in `src/`
- Build output lives in `dist/`
- Example local config lives in `examples/`
- Package metadata lives in `package.json`

When changing behavior, edit `src/` first and rebuild. Do not hand-edit `dist/`.

## Plugin behavior

- The plugin captures microphone audio locally and routes it through the selected ASR provider
- Built-in providers:
  - `volcengine`: realtime websocket ASR with stable utterances appended while recognition is active
  - `mimo`: upload-after-stop ASR that wraps the recorded PCM as WAV and appends the final transcript after stop
- The default shortcut is `Ctrl+S`
- The shortcut is toggle-based, not hold-to-talk, because current OpenCode TUI plugin APIs do not expose key release events
- The current stable interaction uses a long recording toast and clears it when recognition stops; do not reintroduce TSX prompt-right status without local runtime validation

## Config rules

- Never commit real credentials
- Runtime credentials should come from:
  - `~/.config/opencode/voice2text.local.json`, or
  - `OPENCODE_VOICE2TEXT_*` environment variables
- Provider-specific credentials should live under `providerConfig`
- One config file may hold multiple providers at once under `providerConfig.<providerId>`; the top-level `provider` field selects the active provider
- Keep README examples sanitized
- README must document how to fix `Ctrl+S` terminal flow-control conflicts using `stty -ixon`

Preferred config shapes:

```json
{
  "provider": "volcengine",
  "providerConfig": {
    "appId": "...",
    "accessToken": "...",
    "resourceId": "...",
    "endpoint": "..."
  }
}
```

```json
{
  "provider": "mimo",
  "providerConfig": {
    "volcengine": {
      "appId": "...",
      "accessToken": "...",
      "resourceId": "...",
      "endpoint": "..."
    },
    "mimo": {
      "apiKey": "...",
      "model": "mimo-v2.5-asr",
      "endpoint": "https://api.xiaomimimo.com/v1/chat/completions"
    }
  }
}
```

Legacy flat top-level provider fields may still be read for compatibility, but new docs and examples must use `providerConfig`.

## Release expectations

Before claiming the package is ready, run:

```bash
npm run typecheck
npm run build
npm pack --dry-run
```

If package metadata changes, verify:

- `name`
- `version`
- `repository`
- `homepage`
- `bugs`
- published file list from `npm pack --dry-run`

## Release flow

- No GitHub Actions publish workflow is currently committed in this repo
- Releases are currently manual: bump `package.json`, run the release checks, then publish from an owner-authorized environment
- Do not commit npm credentials or tokens into the repo
- If CI publishing is reintroduced later, validate the workflow file and npm trusted publishing setup against the repo's current state before relying on it

## Editing guidance

- Prefer small changes over broad rewrites
- Keep the package consumable as a normal npm OpenCode plugin
- Preserve OpenCode plugin API compatibility
- If adding dependencies, keep them justified and update README when install or publish behavior changes
- Prefer local runtime validation through `~/.config/opencode/tui.json`; direct `file:///.../dist/index.js` plugin entries are fine for local verification before publishing npm versions
- Keep provider implementations isolated under `src/providers/`

## Git commit rules

- Commit messages must be in English
- Always use a conventional prefix such as `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
- Format should be like `feat: add new feature`
- Keep the message concise, but specific enough to describe the main change
- When asked to provide a commit command, output a directly executable git command without extra explanation
