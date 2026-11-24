// Run with Bun and OPENCODE_TEST_BINARY set to an isolated OpenCode executable.
// No microphone or production ASR endpoint is used.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { stripVTControlCharacters } from "node:util"
import { gzipSync, gunzipSync } from "node:zlib"

assert.ok(globalThis.Bun?.Terminal, "Run this test with Bun >= 1.3.14")
assert.ok(process.env.OPENCODE_TEST_BINARY, "Set the explicit binary under test; configuration and data are always isolated")
const v1 = process.env.VOICE_TEST_RUNTIME === "v1"
const repo = fileURLToPath(new URL("../", import.meta.url))
const root = await mkdtemp(path.join(os.tmpdir(), "voice-v2-smoke-"))
let child
let output = ""
const asrRequests = []
const modelRequests = []
let delayedASR = false
let cancelledASR = 0
const cancelledTranscript = "CANCELLED_TRANSCRIPT_MUST_NOT_APPEAR"
const recorderLog = path.join(root, "recorder.log")
const ready = path.join(root, "ready")
const uiSnapshot = path.join(root, "ui.json")
const provider = process.env.VOICE_TEST_PROVIDER || "mimo"
assert.ok(["mimo", "volcengine"].includes(provider))
const bind = provider === "volcengine" ? "ctrl+g" : "ctrl+s"
const toggle = provider === "volcengine" ? "\x07" : "\x13"
const stable = "VOLC_NATIVE_STABLE_8492"
const tail = "FINAL_TAIL_5721"
const transcript = provider === "mimo" ? "MIMO_NATIVE_TRANSCRIPT_8492" : `${stable} ${tail}`
let responseText = transcript
let websocket
let blockedStartup
const startupAttempts = { handshake: 0, ack: 0 }
const startupClosed = { handshake: 0, ack: 0 }
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const body = await request.json()
    if (new URL(request.url).pathname === "/asr") {
      const data = body.messages[0].content[0].input_audio.data
      assert.ok(data.startsWith("data:audio/wav;base64,"))
      const wav = Buffer.from(data.split(",")[1], "base64")
      assert.equal(wav.subarray(0, 4).toString(), "RIFF")
      assert.ok(wav.length > 44, "The fake recorder must provide PCM audio")
      asrRequests.push(body)
      if (delayedASR) {
        request.signal.addEventListener("abort", () => { cancelledASR++ }, { once: true })
        await Bun.sleep(2500)
        return Response.json({ choices: [{ message: { content: cancelledTranscript } }] })
      }
      return Response.json({ choices: [{ message: { content: responseText } }] })
    }
    modelRequests.push(body)
    return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "Fixture answer." }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } })
  },
})

async function until(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`TUI exited: ${child.exitCode}\n${stripVTControlCharacters(output).slice(-6000)}`)
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${label}\n${stripVTControlCharacters(output).slice(-6000)}`)
}

async function recordingEvents() {
  return (await readFile(recorderLog, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

async function visibleText() {
  return JSON.parse(await readFile(uiSnapshot, "utf8").catch(() => "[]")).join("\n")
}

try {
  for (const name of ["home", "project", "bin", "config/opencode/plugins/observer", "data", "cache", "state", "run", "tmp"]) await mkdir(path.join(root, name), { recursive: true })
  await writeFile(path.join(root, "bin/rec"), `#!${process.execPath}\nimport { appendFileSync } from "node:fs";\nconst log = (event) => appendFileSync(process.env.VOICE_RECORDER_LOG, JSON.stringify({event,pid:process.pid}) + "\\n");\nlog("start");\nconst timer = setInterval(() => process.stdout.write(Buffer.alloc(3200)), 100);\nconst stop = () => { clearInterval(timer); log("stop"); process.exit(0); };\nprocess.on("SIGINT", stop); process.on("SIGTERM", stop);\n`, { mode: 0o700 })
  await writeFile(path.join(root, "config/opencode/plugins/observer/package.json"), JSON.stringify({ type: "module", exports: { "./tui": "./tui.js" } }))
  await writeFile(path.join(root, "config/opencode/plugins/observer/tui.js"), `import {writeFileSync,renameSync} from "node:fs";
const ready=()=>{writeFileSync(${JSON.stringify(ready)},"ready")};
export default {id:"voice-fixture-observer",tui:ready,setup(ctx){
  ready();
  ctx.keymap.layer(()=>({mode:"global",commands:[
    {id:"fixture.toast.held",bind:"ctrl+b",run:()=>ctx.ui.toast.show({title:"Fixture",message:"HELD_FIXTURE_TOAST",duration:60000})},
    {id:"fixture.toast.queued",bind:"ctrl+n",run:()=>ctx.ui.toast.show({title:"Fixture",message:"QUEUED_FIXTURE_TOAST",duration:1000})},
  ]}));
  const timer=setInterval(()=>{
    const texts=[];
    const visit=(node)=>{
      if(!node.visible||node.isDestroyed)return;
      if(typeof node.plainText==="string")texts.push(node.plainText);
      else if(typeof node.content==="string")texts.push(node.content);
      for(const child of node.getChildren())visit(child);
    };
    visit(ctx.renderer.root);
    writeFileSync(${JSON.stringify(`${uiSnapshot}.tmp`)},JSON.stringify(texts));
    renameSync(${JSON.stringify(`${uiSnapshot}.tmp`)},${JSON.stringify(uiSnapshot)});
  },50);
  return ()=>clearInterval(timer);
}};`)
  const serverConfig = v1 ? {
    autoupdate: false, snapshot: false,
    model: "fixture/fixture-model", agent: { title: { disable: true } },
    provider: { fixture: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture" }, models: { "fixture-model": { name: "Fixture", limit: { context: 64000, output: 4096 } } } } },
  } : {
    update: "disable", snapshots: false,
    model: "fixture/fixture-model", agents: { title: { disabled: true } },
    providers: { fixture: { package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: "fixture" }, models: { "fixture-model": { name: "Fixture", limit: { context: 64000, output: 4096 } } } } },
  }
  await writeFile(path.join(root, "config/opencode/opencode.json"), JSON.stringify(serverConfig))
  let providerConfig = { apiKey: "fixture", endpoint: `http://127.0.0.1:${server.port}/asr` }
  if (provider === "volcengine") {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(root, "key.pem"), "-out", path.join(root, "cert.pem"), "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "ignore" })
    const packet = (text, flags = 0) => {
      const payload = gzipSync(Buffer.from(JSON.stringify({ result: { text, utterances: text ? [{ text: stable, definite: true }] : [] } })))
      const size = Buffer.alloc(4)
      size.writeUInt32BE(payload.length)
      return Buffer.concat([Buffer.from([0x11, 0x90 | flags, 0x11, 0]), ...(flags === 3 ? [Buffer.alloc(4)] : []), size, payload])
    }
    websocket = Bun.serve({
      hostname: "localhost", port: 0,
      tls: { key: Bun.file(path.join(root, "key.pem")), cert: Bun.file(path.join(root, "cert.pem")) },
      fetch(request, server) {
        assert.equal(request.headers.get("X-Api-Access-Key"), "fixture")
        if (blockedStartup === "handshake") {
          startupAttempts.handshake++
          return new Promise((resolve) => request.signal.addEventListener("abort", () => {
            startupClosed.handshake++
            resolve(new Response(null, { status: 499 }))
          }, { once: true }))
        }
        if (server.upgrade(request, { data: { bytes: 0, startup: blockedStartup } })) return
        return new Response("WebSocket required", { status: 400 })
      },
      websocket: {
        message(socket, frame) {
          const data = Buffer.from(frame)
          const type = data[1] >> 4
          const flags = data[1] & 15
          const payload = gunzipSync(data.subarray(8))
          if (type === 1) {
            assert.equal(JSON.parse(payload).audio.format, "pcm")
            if (socket.data.startup === "ack") {
              startupAttempts.ack++
              return
            }
            socket.send(packet(""))
          } else if (flags === 2) {
            assert.ok(socket.data.bytes > 0)
            asrRequests.push({ bytes: socket.data.bytes })
            socket.send(packet(`${stable}${tail}`, 3))
          } else {
            if (socket.data.bytes === 0) socket.send(packet(stable))
            socket.data.bytes += payload.length
          }
        },
        close(socket) {
          if (socket.data.startup === "ack") startupClosed.ack++
        },
      },
    })
    providerConfig = { endpoint: `wss://localhost:${websocket.port}/asr`, appId: "fixture", accessToken: "fixture", resourceId: "fixture" }
  }
  await writeFile(path.join(root, "voice.json"), JSON.stringify({ provider, commandKeybind: bind, maxDurationSeconds: 60, providerConfig }))
  const packageRoot = process.env.VOICE_TEST_PACKAGE || repo
  const cliConfig = v1 ? { plugin: [[path.join(packageRoot, "dist/index.js"), { configPath: path.join(root, "voice.json") }], path.join(root, "config/opencode/plugins/observer/tui.js")] } : { plugins: [{ package: packageRoot, options: { configPath: path.join(root, "voice.json") } }, path.join(root, "config/opencode/plugins/observer")] }
  await writeFile(path.join(root, `config/opencode/${v1 ? "tui" : "cli"}.json`), JSON.stringify(cliConfig))
  const env = {
    PATH: `${path.join(root, "bin")}:${process.env.PATH}`, HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"), XDG_STATE_HOME: path.join(root, "state"),
    XDG_RUNTIME_DIR: path.join(root, "run"), TMPDIR: path.join(root, "tmp"),
    TERM: "xterm-256color", COLORTERM: "truecolor", VOICE_RECORDER_LOG: recorderLog,
    ...(websocket ? { NODE_EXTRA_CA_CERTS: path.join(root, "cert.pem") } : {}),
  }
  child = Bun.spawn([path.resolve(process.env.OPENCODE_TEST_BINARY), ...(v1 ? [] : ["--standalone"])], {
    cwd: path.join(root, "project"), env,
    terminal: {
      cols: 110, rows: 35,
      data(terminal, data) {
        const text = Buffer.from(data).toString()
        output += text
        if (text.includes("\x1b[6n")) terminal.write("\x1b[1;1R")
        if (text.includes("\x1b[c")) terminal.write("\x1b[?1;2c")
        if (text.includes("\x1b[?u")) terminal.write("\x1b[?0u")
      },
    },
  })
  await until(() => readFile(ready).then(() => true, () => false), "TUI plugin loading")
  await Bun.sleep(500)
  if (websocket && !v1) {
    for (const stage of ["handshake", "ack"]) {
      blockedStartup = stage
      child.terminal.write(toggle)
      await until(() => startupAttempts[stage] > 0, `Pending ${stage} reaches the local server`)
      assert.equal((await recordingEvents()).length, 0, "Microphone capture must not begin before ASR is ready")
      child.terminal.write(toggle)
      await until(() => startupClosed[stage] > 0, `Cancellation closes the pending ${stage} connection`, 1500)
    }
    blockedStartup = undefined
    console.log("Native V2 pending WebSocket handshake/initial-response cancellation closes the connection without recording: passed")
  }
  const draft = v1 ? "draft " : "prefix middle suffix "
  child.terminal.write(draft)
  if (!v1) {
    child.terminal.write("\x1b[H" + "\x1b[C".repeat(7) + "\x1b[1;2C".repeat(6))
    await Bun.sleep(100)
  }
  child.terminal.write(toggle)
  await until(async () => (await recordingEvents()).some((event) => event.event === "start"), "Shortcut starts the fake recorder")
  if (!v1) {
    await until(async () => ((await visibleText()).match(/Listening\.\.\./g) ?? []).length === 2,
      "The native global toast and footer both show recording status")
    child.terminal.write("\x02")
    await until(async () => (await visibleText()).includes("HELD_FIXTURE_TOAST"), "Unrelated toast appears")
    // Pause an unrelated toast under the mouse, then deliberately create a queued toast.
    child.terminal.write("\x1b[<35;90;4M")
    await Bun.sleep(100)
    child.terminal.write("\x0e")
    await until(async () => (await visibleText()).includes("+1 more"), "Mouse hover pauses a real toast queue")
    assert.ok((await visibleText()).includes("Listening"), "A queued toast must not replace the recording indicator")
  }
  if (websocket) await until(() => stripVTControlCharacters(output).includes(stable), "Stable transcript streams into the prompt before stop")
  await Bun.sleep(450)
  child.terminal.write(toggle)
  await until(() => asrRequests.length === 1, "Shortcut stops and finishes ASR")
  await until(() => stripVTControlCharacters(output).includes(websocket ? tail : transcript), "ASR transcript reaches the visible prompt")
  if (!v1) {
    await until(async () => !(await visibleText()).includes("Voice2Text:"), "Recording/transcription status is removed even while the pointer stays in the toast area")
    assert.ok((await visibleText()).includes("HELD_FIXTURE_TOAST"), "The unrelated toast must not be cleared by voice input")
    await until(async () => (await visibleText()).includes("+3 more"), "Voice state and clear toasts join the paused global queue")
    child.terminal.write("\x1b[<0;90;4M\x1b[<0;90;4m")
    child.terminal.write("\x1b[<35;1;35M")
    await until(async () => !(await visibleText()).includes("HELD_FIXTURE_TOAST"), "Dismiss the test toast")
    // Dismiss the remaining test queue before checking later voice interactions.
    for (let i = 0; i < 3; i++) {
      child.terminal.write("\x1b[<0;90;4M\x1b[<0;90;4m")
      await Bun.sleep(100)
    }
    child.terminal.write("\x1b[<35;1;35M")
  }
  assert.equal(modelRequests.length, 0, "Recognition must not automatically submit the prompt")
  child.terminal.write("\r")
  await until(() => modelRequests.length > 0, "Manual prompt submission")
  const user = modelRequests[0].messages.findLast((message) => message.role === "user")
  const prompt = typeof user.content === "string" ? user.content : user.content.map((part) => part.text ?? "").join("")
  assert.ok(prompt.includes(`${draft}${transcript}`), `Selected draft must stay intact and recognition must append at the end: ${prompt}`)
  assert.equal(prompt.split(transcript).length - 1, 1, "The final transcript must be appended once")
  if (!v1 && provider === "mimo") {
    await Bun.sleep(500)
    delayedASR = true
    child.terminal.write("cancel draft ")
    child.terminal.write(toggle)
    await until(async () => (await recordingEvents()).filter((event) => event.event === "start").length === 2, "Second recording starts")
    await Bun.sleep(450)
    child.terminal.write(toggle)
    await until(() => asrRequests.length === 2, "Delayed ASR request starts")
    child.terminal.write(toggle)
    await until(() => stripVTControlCharacters(output).includes("Still transcribing"), "First transcription toggle asks for confirmation")
    child.terminal.write(toggle)
    await until(() => cancelledASR > 0, "Second transcription toggle aborts the HTTP request")
    await Bun.sleep(2700)
    assert.ok(!stripVTControlCharacters(output).includes(cancelledTranscript), "Cancelled output must not enter the prompt")
    assert.equal(modelRequests.length, 1)
    child.terminal.write("\r")
    await until(() => modelRequests.length === 2, "Submit only the preserved manual draft")
    const cancelledUser = modelRequests[1].messages.findLast((message) => message.role === "user")
    assert.ok(JSON.stringify(cancelledUser).includes("cancel draft"))
    assert.ok(!JSON.stringify(cancelledUser).includes(cancelledTranscript))
    console.log("Native V2 transcription cancellation: first toggle warns, second aborts, no late append: passed")

    await Bun.sleep(500)
    delayedASR = false
    for (const alias of ["/voice", "/voice2text"]) {
      const startCount = (await recordingEvents()).filter((event) => event.event === "start").length
      const asrCount = asrRequests.length
      const modelCount = modelRequests.length
      responseText = `SLASH_${alias.slice(1).toUpperCase()}_TRANSCRIPT`
      child.terminal.write(alias)
      await Bun.sleep(300)
      child.terminal.write("\r")
      await until(async () => (await recordingEvents()).filter((event) => event.event === "start").length === startCount + 1, "Slash command starts recording")
      assert.equal(modelRequests.length, modelCount, "Slash command must not become a model prompt")
      await Bun.sleep(450)
      child.terminal.write(toggle)
      await until(() => asrRequests.length === asrCount + 1, "Shortcut stops slash-started recording")
      await until(() => stripVTControlCharacters(output).includes(responseText), "Slash-started result reaches prompt")
      child.terminal.write("\r")
      await until(() => modelRequests.length === modelCount + 1, "Manually submit slash-started result")
      assert.ok(JSON.stringify(modelRequests.at(-1).messages.findLast((message) => message.role === "user")).includes(responseText))
      await Bun.sleep(300)
      console.log(`Native V2 ${alias} slash command: passed`)
    }
    const beforeSwitch = (await recordingEvents()).filter((event) => event.event === "start").length
    const requestsBeforeSwitch = asrRequests.length
    child.terminal.write(toggle)
    await until(async () => (await recordingEvents()).filter((event) => event.event === "start").length === beforeSwitch + 1, "Record before switching sessions")
    child.terminal.write("/new")
    await Bun.sleep(300)
    child.terminal.write("\r")
    await until(async () => (await recordingEvents()).filter((event) => event.event === "stop").length === beforeSwitch + 1, "Session switch aborts the recorder")
    await until(async () => !(await visibleText()).includes("Voice2Text:"), "Session switch removes recording status")
    assert.equal(asrRequests.length, requestsBeforeSwitch, "Navigation cancellation must not upload the discarded recording")
    console.log("Native V2 session switch cancels recording without uploading: passed")

    child.terminal.write(toggle)
    await until(async () => (await recordingEvents()).filter((event) => event.event === "start").length === beforeSwitch + 2, "Record before TUI shutdown")
    child.terminal.write("\x03")
    await Bun.sleep(200)
    if (child.exitCode === null) child.terminal.write("\x03")
    await Promise.race([child.exited, Bun.sleep(5000).then(() => { throw new Error("TUI did not shut down after Ctrl+C") })])
    await Bun.sleep(100)
    assert.equal((await recordingEvents()).filter((event) => event.event === "stop").length, beforeSwitch + 2, "TUI disposal must stop its recorder")
    assert.equal(asrRequests.length, requestsBeforeSwitch)
    console.log("Native V2 TUI shutdown disposes recording without uploading: passed")
  }
  const events = await recordingEvents()
  assert.equal(events.filter((event) => event.event === "start").length, events.filter((event) => event.event === "stop").length)
  console.log(`Native ${v1 ? "V1" : "V2"} TUI ${provider} (${bind}): start/stop, ${websocket ? "realtime stable text + final tail" : "PCM-to-WAV upload"}, preserved draft, single append, no automatic submission: passed`)
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM")
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000)
    await child.exited
    clearTimeout(timer)
  }
  child?.terminal?.close()
  for (const event of await recordingEvents()) {
    if (event.event === "start" && !(await recordingEvents()).some((item) => item.event === "stop" && item.pid === event.pid)) {
      try { process.kill(event.pid, "SIGTERM") } catch {}
    }
  }
  await server.stop(true)
  await websocket?.stop(true)
  await rm(root, { recursive: true, force: true })
}
