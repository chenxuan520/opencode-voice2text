import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { mock, test } from "node:test"

const children = []
mock.module("node:child_process", {
  namedExports: {
    spawn(command) {
      const child = new EventEmitter()
      child.command = command
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.kill = () => { queueMicrotask(() => child.emit("close", 0, "SIGINT")); return true }
      children.push(child)
      if (command === "which" || command === "where") queueMicrotask(() => child.emit("close", 0))
      return child
    },
  },
})
const { startVoiceRecognition } = await import("../dist/runtime.js")
const settle = () => new Promise((resolve) => setImmediate(resolve))
const config = { rate: 16000, channels: 1, bits: 16, chunkMs: 200, maxDurationSeconds: 10 }

test("runtime: cancelling pending ASR startup aborts its late session without starting a recorder", async () => {
  let ready, aborted = 0
  const stream = { abort: async () => { aborted++ } }
  const provider = { validateConfig: () => undefined, createRecognition: () => new Promise((resolve) => { ready = resolve }) }
  const controller = new AbortController()
  const starting = startVoiceRecognition(config, provider, {}, controller.signal)
  await settle()
  controller.abort()
  ready(stream)
  await assert.rejects(starting, { name: "AbortError" })
  assert.equal(aborted, 1)
  assert.ok(children.every((child) => child.command === "which" || child.command === "where"))
})

test("runtime: already cancelled startup does not check recorder or create ASR", async () => {
  const controller = new AbortController()
  controller.abort()
  const before = children.length
  await assert.rejects(startVoiceRecognition(config, {}, {}, controller.signal), { name: "AbortError" })
  assert.equal(children.length, before)
})

test("runtime: forwards cancellation to pending provider initialization", async () => {
  const controller = new AbortController()
  const before = children.length
  const callbacks = {}
  let cancelled = false
  const provider = {
    validateConfig: () => undefined,
    createRecognition: (receivedConfig, receivedCallbacks, signal) => {
      assert.equal(receivedConfig, config)
      assert.equal(receivedCallbacks, callbacks)
      assert.equal(signal, controller.signal)
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => { cancelled = true; reject(signal.reason) }, { once: true })
      })
    },
  }
  const starting = startVoiceRecognition(config, provider, callbacks, controller.signal)
  const rejected = assert.rejects(starting, { name: "AbortError" })
  await settle()
  controller.abort()
  await rejected
  assert.equal(cancelled, true)
  assert.ok(children.slice(before).every((child) => child.command === "which" || child.command === "where"))
})

test("runtime: standalone caller without signal still records PCM, stops once and flushes final tail", async () => {
  const chunks = [], result = { text: "final", stableText: "", logId: "fake" }
  let finishes = 0, aborted = 0
  const provider = {
    validateConfig: () => undefined,
    createRecognition: async () => ({
      write: (chunk) => chunks.push(chunk),
      finish: async (tail) => { finishes++; chunks.push(tail); return result },
      abort: async () => { aborted++ },
    }),
  }
  const run = await startVoiceRecognition(config, provider, {})
  const recorder = children.at(-1)
  assert.ok(["rec", "sox"].includes(recorder.command))
  const audio = Buffer.alloc(6403, 1)
  recorder.stdout.write(audio)
  await settle()
  assert.equal(await run.stop(), result)
  assert.equal(await run.stop(), result)
  assert.equal(finishes, 1)
  assert.deepEqual(Buffer.concat(chunks), audio)
  assert.equal(aborted, 0)
})

test("runtime: cancelling stop before recorder closes cannot start an upload", async () => {
  let finishes = 0
  const controller = new AbortController()
  const run = await startVoiceRecognition(config, {
    validateConfig: () => undefined,
    createRecognition: async () => ({
      write() {},
      finish: async () => { finishes++; return { text: "late", stableText: "", logId: "" } },
      abort: async () => {},
    }),
  }, {}, controller.signal)
  const stopping = run.stop()
  controller.abort()
  await run.abort()
  await assert.rejects(stopping, { name: "AbortError" })
  assert.equal(finishes, 0)
})
