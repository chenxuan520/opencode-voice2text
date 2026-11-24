# Verification

Run `npm test` for the mocked lifecycle, runtime and standalone CLI regressions, and `npm run typecheck` for the package types.

## Native TUI

`runtime-v2-smoke.mjs` runs an actual OpenCode terminal in a Bun PTY. It requires an explicitly selected executable, Bun >= 1.3.14, and `openssl` for the Volcengine fixture. It does not download or install OpenCode.

```sh
npm run build
OPENCODE_TEST_BINARY=/path/to/test-only/opencode-v2 bun tests/runtime-v2-smoke.mjs
OPENCODE_TEST_BINARY=/path/to/test-only/opencode-v2 VOICE_TEST_PROVIDER=volcengine bun tests/runtime-v2-smoke.mjs
OPENCODE_TEST_BINARY=/path/to/opencode-v1 VOICE_TEST_RUNTIME=v1 bun tests/runtime-v2-smoke.mjs
```

The checked runtime versions are OpenCode 2.2.5, 2.3.2 and 1.18.16. To verify the packed package instead of the checkout, set `VOICE_TEST_PACKAGE` to the extracted npm package directory. Build and pack before doing so.

The test creates an isolated HOME, XDG directories and project under the temporary directory. A fake `rec` executable at the front of PATH emits synthetic PCM; no microphone is opened. MiMo HTTP and Volcengine TLS/WebSocket fixtures run on loopback with dummy credentials. The temporary certificate is trusted only by the test child. A loopback model verifies the manually submitted prompt; no production ASR or inference endpoint is configured.

Native checks cover keyboard start/stop, custom bindings, visible prompt insertion, a selection in the middle of the existing draft, streaming stable text plus final tail, no duplicate or automatic submission, and recorder shutdown. An observer checks that the global recording toast and footer are both rendered, and that voice updates/clearing join a real paused global toast queue while the footer is removed independently. The V2 MiMo run additionally checks real request cancellation and both `/voice` and `/voice2text` in autocomplete mode. The V2 Volcengine run checks cancellation while WebSocket upgrade and the first binary response are pending, before the recorder starts.

The script stops only its own TUI/fake recorder processes and removes its temporary configuration and data. It never updates the installed executable, user configuration or caches.
