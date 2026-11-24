import assert from "node:assert/strict"
import { EventEmitter, getEventListeners } from "node:events"
import { mock, test } from "node:test"
import zlib from "node:zlib"

const sockets = []
class FakeTLSSocket extends EventEmitter {
  destroyed = false
  destroyCalls = 0
  writes = []
  setNoDelay() {}
  write(data) {
    assert.equal(this.destroyed, false, "must not write after destroy")
    this.writes.push(data)
    return true
  }
  end(callback) {
    if (callback) queueMicrotask(callback)
    return this
  }
  destroy() {
    this.destroyCalls++
    if (!this.destroyed) {
      this.destroyed = true
      // Like a real TLSSocket, destroy is synchronous but close is asynchronous.
      queueMicrotask(() => this.emit("close", false))
    }
    return this
  }
}
mock.module("node:tls", {
  defaultExport: { connect() { const socket = new FakeTLSSocket(); sockets.push(socket); return socket } },
})
mock.module("node:child_process", {
  namedExports: {
    spawn(command) {
      assert.ok(command === "which" || command === "where", "cancelled startup must not spawn a recorder")
      const child = new EventEmitter()
      queueMicrotask(() => child.emit("close", 0))
      return child
    },
  },
})
const { volcengineProvider } = await import("../dist/providers/volcengine.js")
const { startVoiceRecognition } = await import("../dist/runtime.js")
const settle = () => new Promise((resolve) => setImmediate(resolve))
const config = {
  rate: 16000, channels: 1, bits: 16, chunkMs: 200, maxDurationSeconds: 10,
  providerConfig: { endpoint: "wss://asr.invalid/test", appId: "fake", accessToken: "fake", resourceId: "fake" },
}
const upgrade = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nx-tt-logid: fake-log\r\n\r\n")

function response(data = {}, final = false) {
  const payload = zlib.gzipSync(Buffer.from(JSON.stringify(data)))
  const header = Buffer.alloc(final ? 12 : 8)
  header.set([0x11, final ? 0x93 : 0x90, 0x11, 0])
  if (final) header.writeInt32BE(-1, 4)
  header.writeUInt32BE(payload.length, header.length - 4)
  const body = Buffer.concat([header, payload])
  const frame = Buffer.alloc(body.length < 126 ? 2 : 4)
  frame[0] = 0x82
  frame[1] = body.length < 126 ? body.length : 126
  if (body.length >= 126) frame.writeUInt16BE(body.length, 2)
  return Buffer.concat([frame, body])
}

function clientMessage(frame) {
  assert.ok(Buffer.isBuffer(frame))
  assert.equal(frame[0], 0x82)
  assert.ok(frame[1] & 0x80, "client websocket frames must be masked")
  const offset = (frame[1] & 0x7f) === 126 ? 4 : 2
  const mask = frame.subarray(offset, offset + 4)
  const body = Buffer.from(frame.subarray(offset + 4))
  for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4]
  return { type: body[1] >> 4, flags: body[1] & 0xf, payload: zlib.gunzipSync(body.subarray(8)) }
}

function fixture(t) {
  const timers = new Map()
  const set = globalThis.setTimeout, clear = globalThis.clearTimeout
  t.mock.method(globalThis, "setTimeout", (callback, delay, ...args) => {
    const fire = () => { timers.delete(timer); clear(timer); callback(...args) }
    const timer = set(fire, delay)
    timers.set(timer, { fire, delay })
    return timer
  })
  t.mock.method(globalThis, "clearTimeout", (timer) => { timers.delete(timer); clear(timer) })
  const firstSocket = sockets.length
  t.after(() => {
    for (const socket of sockets.slice(firstSocket)) if (!socket.destroyed) socket.destroy()
    for (const timer of timers.keys()) clear(timer)
  })
  return {
    expireTimeout(delay) {
      assert.equal(timers.size, 1)
      const timer = [...timers.values()][0]
      assert.equal(timer.delay, delay)
      timer.fire()
    },
    async assertClean(socket, signal) {
      await settle()
      assert.equal(socket.destroyed, true)
      assert.equal(socket.destroyCalls, 1)
      assert.deepEqual(socket.eventNames(), [], "all socket listeners must be removed after close")
      if (signal) assert.equal(getEventListeners(signal, "abort").length, 0)
      assert.equal(timers.size, 0, "all network/close timers must be cleared")
    },
  }
}

async function advance(socket, stage) {
  if (stage === "TLS") return
  socket.emit("secureConnect")
  await settle()
  assert.equal(socket.writes.length, 1)
  assert.match(socket.writes[0], /^GET \/test HTTP\/1.1/)
  if (stage === "HTTP upgrade") return
  // Split headers to exercise the incremental HTTP parser, not a mocked connect().
  socket.emit("data", upgrade.subarray(0, 17))
  socket.emit("data", upgrade.subarray(17))
  await settle()
  assert.equal(socket.writes.length, 2)
  const init = clientMessage(socket.writes[1])
  assert.equal(init.type, 1)
  assert.equal(JSON.parse(init.payload).audio.rate, config.rate)
}

for (const stage of ["TLS", "HTTP upgrade", "initial binary response"]) {
  for (const viaRuntime of [false, true]) {
    test(`volcengine: abort during ${stage}${viaRuntime ? " through real runtime" : ""}`, async (t) => {
      const { assertClean } = fixture(t)
      const controller = new AbortController()
      const starting = viaRuntime
        ? startVoiceRecognition(config, volcengineProvider, {}, controller.signal)
        : volcengineProvider.createRecognition(config, {}, controller.signal)
      void starting.catch(() => undefined)
      await settle()
      const socket = sockets.at(-1)
      await advance(socket, stage)
      const writes = socket.writes.length
      controller.abort()
      assert.equal(socket.destroyed, true, "abort must destroy the socket synchronously")
      await assert.rejects(starting, { name: "AbortError" })
      // Late transport events must not restart initialization or write anything.
      socket.emit("secureConnect")
      socket.emit("data", Buffer.concat([upgrade, response()]))
      assert.equal(socket.writes.length, writes)
      await assertClean(socket, controller.signal)
    })
  }

  for (const failure of ["remote close", "socket error", "timeout"]) {
    test(`volcengine: ${failure} during ${stage} rejects and cleans up`, async (t) => {
      const { assertClean, expireTimeout } = fixture(t)
      const controller = new AbortController()
      const starting = volcengineProvider.createRecognition(config, {}, controller.signal)
      void starting.catch(() => undefined)
      const socket = sockets.at(-1)
      await advance(socket, stage)
      if (failure === "remote close") socket.destroy()
      else if (failure === "socket error") socket.emit("error", new Error("fake socket error"))
      else expireTimeout(30_000)
      let rejected = false
      void starting.catch(() => { rejected = true })
      await settle()
      assert.equal(rejected, true, "transport failure must reject promptly")
      await assert.rejects(starting, /closed|fake socket error|timed out/i)
      await assertClean(socket, controller.signal)
    })
  }
}

test("volcengine: already aborted startup does not create TLS resources", async () => {
  const controller = new AbortController()
  const reason = new Error("cancelled before connect")
  controller.abort(reason)
  const before = sockets.length
  const starting = volcengineProvider.createRecognition(config, {}, controller.signal)
  void starting.catch(() => undefined)
  assert.equal(sockets.length, before)
  await assert.rejects(starting, (error) => error === reason)
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})

for (const stage of ["TLS", "HTTP upgrade", "initial binary response"]) {
  test(`volcengine: abort after ${stage} resolves but before continuation sends nothing further`, async (t) => {
    const { assertClean } = fixture(t)
    const controller = new AbortController()
    const starting = volcengineProvider.createRecognition(config, {}, controller.signal)
    void starting.catch(() => undefined)
    const socket = sockets.at(-1)
    if (stage === "TLS") socket.emit("secureConnect")
    else if (stage === "HTTP upgrade") { await advance(socket, stage); socket.emit("data", upgrade) }
    else { await advance(socket, stage); socket.emit("data", response()) }
    const writes = socket.writes.length
    controller.abort()
    // Errors already queued by TLS must still have a listener until close.
    socket.emit("error", new Error("late TLS error"))
    await assert.rejects(starting, { name: "AbortError" })
    assert.equal(socket.writes.length, writes)
    await assertClean(socket, controller.signal)
  })
}

for (const withSignal of [false, true]) {
  test(`volcengine: normal masked audio/final transcript and idempotent cleanup ${withSignal ? "with signal" : "without signal (CLI)"}`, async (t) => {
    const { assertClean } = fixture(t)
    const controller = new AbortController()
    const stable = []
    const starting = volcengineProvider.createRecognition(config, { onStableText: async (text) => { stable.push(text) } }, withSignal ? controller.signal : undefined)
    const socket = sockets.at(-1)
    await advance(socket, "initial binary response")
    socket.emit("data", response())
    const session = await starting
    session.write(Buffer.from([1, 2]))
    const finishing = session.finish(Buffer.from([3, 4]))
    const repeated = session.finish()
    await settle()
    assert.deepEqual(socket.writes.slice(2).map(clientMessage), [
      { type: 2, flags: 0, payload: Buffer.from([1, 2]) },
      { type: 2, flags: 0, payload: Buffer.from([3, 4]) },
      { type: 2, flags: 2, payload: Buffer.alloc(0) },
    ])
    socket.emit("data", response({ result: { text: "hello", utterances: [{ text: "hello", definite: true }] } }, true))
    const result = { text: "hello", stableText: "hello", logId: "fake-log" }
    assert.deepEqual(await finishing, result)
    assert.deepEqual(await repeated, result)
    assert.deepEqual(stable, ["hello"])
    await assertClean(socket, controller.signal)
    controller.abort()
    await session.abort()
    await session.abort()
    await assertClean(socket, controller.signal)
  })
}

for (const finishing of [false, true]) {
  test(`volcengine: abort with ${finishing ? "finish pending" : "queued audio"} is idempotent and has no unhandled rejection`, async (t) => {
    const { assertClean } = fixture(t)
    const controller = new AbortController()
    const starting = volcengineProvider.createRecognition(config, {}, controller.signal)
    const socket = sockets.at(-1)
    await advance(socket, "initial binary response")
    socket.emit("data", response())
    const session = await starting
    session.write(Buffer.from([1, 2]))
    const finished = finishing ? assert.rejects(session.finish(), /closed/i) : undefined
    const writes = socket.writes.length
    controller.abort()
    await session.abort()
    await session.abort()
    if (finished) await finished
    else await assert.rejects(session.finish(), /closed/i)
    assert.equal(socket.writes.length, writes)
    await assertClean(socket, controller.signal)
  })
}

test("volcengine: rejected HTTP upgrade destroys connection and removes listeners", async (t) => {
  const { assertClean } = fixture(t)
  const controller = new AbortController()
  const starting = volcengineProvider.createRecognition(config, {}, controller.signal)
  const rejected = assert.rejects(starting, /WebSocket handshake failed/)
  const socket = sockets.at(-1)
  await advance(socket, "HTTP upgrade")
  socket.emit("data", Buffer.from("HTTP/1.1 403 Forbidden\r\n\r\n"))
  await rejected
  assert.equal(socket.writes.length, 1)
  await assertClean(socket, controller.signal)
})

test("volcengine: stalled graceful close uses the existing fallback and cleans up once", async (t) => {
  const { assertClean, expireTimeout } = fixture(t)
  const controller = new AbortController()
  const starting = volcengineProvider.createRecognition(config, {}, controller.signal)
  const socket = sockets.at(-1)
  await advance(socket, "initial binary response")
  socket.emit("data", response())
  const session = await starting
  socket.end = () => socket
  const finishing = session.finish()
  socket.emit("data", response({}, true))
  await settle()
  expireTimeout(200)
  await finishing
  await session.abort()
  await assertClean(socket, controller.signal)
})
