import { mock } from "node:test"
import * as runtime from "../../dist/runtime.js"

mock.module(new URL("../../dist/runtime.js", import.meta.url).href, {
  namedExports: {
    ...runtime,
    loadConfig: async (options) => ({ appendTrailingSpace: true, maxDurationSeconds: 0.01, ...options }),
    createRuntimeConfig: (config) => ({ config, provider: {} }),
    startVoiceRecognition: async (_config, _provider, callbacks) => {
      await callbacks.onStableText("hello")
      return {
        stop: async () => ({ text: "hello world", stableText: "hello", logId: "fake" }),
        abort: async () => {},
      }
    },
  },
})
