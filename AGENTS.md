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
- The current stable interaction uses a long recording toast and clears it when recognition stops; do not reintroduce TSX prompt-right status without local runtime validation

## Config rules

- Never commit real credentials
- Runtime credentials should come from:
  - `~/.config/opencode/voice2text.local.json`, or
  - `OPENCODE_VOICE2TEXT_*` environment variables
- Provider-specific credentials should live under `providerConfig`
- Keep README examples sanitized
- README must document how to fix `Ctrl+S` terminal flow-control conflicts using `stty -ixon`

Current preferred config shape:

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

Legacy flat fields may still be read for compatibility, but new docs and examples must use `providerConfig`.

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

## CI publish flow

- GitHub Actions workflow: `.github/workflows/publish.yml`
- Trigger: push to `master`
- CI runs typecheck and build before publish
- CI only publishes when the current `package.json` version does not already exist on npm
- CI uses npm trusted publishing via GitHub Actions OIDC
- Required workflow permission: `id-token: write`
- Do not commit npm credentials or tokens into the repo
- Do not add long-lived npm publish tokens to GitHub secrets when trusted publishing is enabled

When preparing a release, bump `package.json` version before pushing to `master`. If the version is unchanged, CI will skip publish.

## Editing guidance

- Prefer small changes over broad rewrites
- Keep the package consumable as a normal npm OpenCode plugin
- Preserve OpenCode plugin API compatibility
- If adding dependencies, keep them justified and update README when install or publish behavior changes
- Prefer local runtime validation through `~/.config/opencode/tui.json` and `~/.config/opencode/plugins/` before publishing npm versions
- Keep provider implementations isolated under `src/providers/`

## Git commit rules

- Commit messages must be in English
- Always use a conventional prefix such as `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`
- Format should be like `feat: add new feature`
- Keep the message concise, but specific enough to describe the main change
- When asked to provide a commit command, output a directly executable git command without extra explanation
