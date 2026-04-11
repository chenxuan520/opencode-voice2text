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

- The plugin streams microphone audio to Volcengine ASR over websocket
- Stable utterances are appended into the OpenCode prompt while recognition is active
- The default shortcut is `Ctrl+S`
- The shortcut is toggle-based, not hold-to-talk, because current OpenCode TUI plugin APIs do not expose key release events

## Config rules

- Never commit real credentials
- Runtime credentials should come from:
  - `~/.config/opencode/voice2text.local.json`, or
  - `OPENCODE_VOICE2TEXT_*` environment variables
- Keep README examples sanitized

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

## Editing guidance

- Prefer small changes over broad rewrites
- Keep the package consumable as a normal npm OpenCode plugin
- Preserve OpenCode plugin API compatibility
- If adding dependencies, keep them justified and update README when install or publish behavior changes
