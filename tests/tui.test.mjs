import assert from "node:assert/strict"
import { mock, test } from "node:test"
import * as runtime from "../dist/runtime.js"

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const settle = () => new Promise((resolve) => setImmediate(resolve))
let fixture
mock.module("@opentui/solid/jsx-runtime", {
  namedExports: { jsx: (type, props) => ({ type, props }) },
})
mock.module("../dist/runtime.js", {
  namedExports: {
    ...runtime,
    loadConfig: async (options) => ({
      commandKeybind: "ctrl+s", provider: "fake", appendTrailingSpace: true, ...options,
    }),
    createRuntimeConfig: (config) => ({ config, provider: fixture.provider }),
    ensureRuntimeSupport: () => fixture.support.promise,
    startVoiceRecognition: async (_config, _provider, callbacks, signal) => {
      fixture.starts++
      fixture.callbacks = callbacks
      fixture.signal = signal
      const run = fixture.run
      await fixture.start.promise
      return run
    },
  },
})
const { default: plugin } = await import("../dist/index.js")

function editor(text = "") {
  return {
    visible: true, isDestroyed: false, parent: null, traits: { owner: "opencode", role: "prompt" },
    text, cursor: 0, selection: undefined, parts: [{ type: "attachment", name: "keep" }],
    getChildren: () => [],
    clearSelection() { const had = !!this.selection; this.selection = undefined; return had },
    gotoBufferEnd() {
      // OpenTUI 0.8.0 collapses a selection and returns without moving to buffer end.
      if (this.selection) { this.cursor = this.selection[1]; this.clearSelection(); return true }
      this.cursor = this.text.length
      return true
    },
    insertText(text) {
      if (this.selection) {
        const [start, end] = this.selection
        this.text = this.text.slice(0, start) + this.text.slice(end)
        this.cursor = start
        this.clearSelection()
      }
      this.text = this.text.slice(0, this.cursor) + text + this.text.slice(this.cursor)
      this.cursor += text.length
    },
  }
}

async function setup(version, options = {}, pending = {}) {
  const support = deferred(), start = deferred(), result = deferred(), abort = deferred()
  if (!pending.support) support.resolve()
  if (!pending.start) start.resolve()
  if (!pending.abort) abort.resolve()
  fixture = {
    support, start, result, abort, starts: 0, stops: 0, aborts: 0,
    provider: { displayName: "Fake ASR", validateConfig: () => undefined },
    run: {
      stop() { fixture.stops++; return result.promise },
      abort() { fixture.aborts++; return abort.promise },
    },
  }
  const state = fixture
  state.toasts = []
  state.prompt = editor("typed ")
  state.route = { type: "session", sessionID: "one" }
  state.unregistered = 0
  state.mode = "base"
  state.slots = new Set()
  state.footer = () => [...state.slots].map((claim) => claim.render({ sessionID: state.route.sessionID })?.props.content).filter(Boolean).join("")
  let command, cleanup
  if (version === "v1") {
    const lifecycle = new AbortController()
    await plugin.tui({
      ui: { toast: (value) => state.toasts.push(value) },
      route: { get current() { return { name: state.route.type, params: { sessionID: state.route.sessionID } } } },
      client: { tui: { appendPrompt: async ({ text }) => { state.prompt.text += text } } },
      command: { register: (factory) => { [command] = factory(); return () => state.unregistered++ } },
      lifecycle: { signal: lifecycle.signal, onDispose: (fn) => { cleanup = fn } },
    }, options)
  } else {
    const hidden = editor("hidden ")
    const search = editor("search ")
    search.traits = { owner: "dialog", role: "search" }
    state.hidden = hidden
    state.search = search
    state.treeReads = 0
    const branch = (children) => {
      const node = {
        visible: true, isDestroyed: false, parent: null, children,
        getChildren() { state.treeReads++; return this.children.slice() },
      }
      for (const child of children) child.parent = node
      return node
    }
    const hiddenBranch = branch([hidden])
    hiddenBranch.visible = false
    state.container = branch([state.prompt])
    state.root = branch([hiddenBranch, search, state.container])
    state.toastQueue = []
    state.showToast = (value) => {
      state.toasts.push(value)
      if (state.currentToast && (state.toastPaused || state.toastQueue.length)) state.toastQueue.push(value)
      else state.currentToast = value
    }
    cleanup = await plugin.setup({
      options,
      ui: {
        toast: { show: state.showToast }, router: { current: () => state.route },
        slot: (claim) => { state.slots.add(claim); return () => state.slots.delete(claim) },
      },
      renderer: { root: state.root },
      keymap: { layer: (factory) => { state.layer = factory(); [command] = state.layer.commands } },
    })
  }
  state.command = command
  // v2 useCommands() exposes only commands reachable in the current input mode.
  state.commands = () => {
    if (version === "v1") return [command]
    return state.layer.mode === "global" || (state.layer.mode ?? "base") === state.mode ? state.layer.commands : []
  }
  state.toggle = () => (version === "v1" ? command.onSelect() : command.run())
  state.slash = (name) => {
    state.mode = "autocomplete"
    const selected = state.commands().find((item) => [item.slash.name, ...item.slash.aliases].includes(name))
    assert.ok(selected, `/${name} must remain reachable while autocomplete is open`)
    state.mode = "base" // The host hides autocomplete before running the selected command.
    state.toggle()
  }
  state.key = (key) => {
    if (key === (version === "v1" ? command.keybind : command.bind)) state.toggle()
  }
  state.dispose = cleanup
  return state
}

for (const version of ["v1", "v2"]) {
  test(`${version}: command, slash aliases, default/custom key and stream/final deduplication`, async () => {
    for (const commandKeybind of [undefined, "ctrl+g"]) {
      const f = await setup(version, commandKeybind ? { commandKeybind } : {})
      try {
        assert.equal(version === "v1" ? f.command.value : f.command.id, "voice2text.toggle")
        assert.equal(f.command.title, "Toggle voice input")
        if (version === "v2") assert.equal(f.command.palette, true)
        assert.deepEqual(f.command.slash, { name: "voice2text", aliases: ["voice"] })
        if (commandKeybind) { f.key("ctrl+s"); await settle(); assert.equal(f.starts, 0) }
        f.key(commandKeybind ?? "ctrl+s")
        await settle()
        assert.equal(f.starts, 1)
        assert.equal(f.toasts[0]?.duration, 3_600_000)
        assert.match(f.toasts[0]?.message, /Listening/)
        if (version === "v2") {
          assert.match(f.footer(), /Voice2Text: Listening/)
        }
        await f.callbacks.onStableText(" hello ")
        f.prompt.text += "manual "
        f.slash("voice")
        if (version === "v2") {
          assert.match(f.footer(), /Transcribing/)
          assert.match(f.currentToast.message, /Transcribing/)
        }
        f.result.resolve({ text: "hello world", stableText: "hello" })
        await settle()
        assert.equal(f.prompt.text, "typed hello manual world ")
        assert.equal(f.toasts.at(-1).duration, 1)
        if (version === "v2") assert.equal(f.footer(), "")
        f.slash("voice2text")
        await settle()
        assert.equal(f.starts, 2)
      } finally { await f.dispose() }
    }
  })

  test(`${version}: no trailing space and upload-only final result`, async () => {
    const f = await setup(version, { appendTrailingSpace: false })
    try {
      f.toggle(); await settle(); f.toggle()
      f.result.resolve({ text: "  final only  ", stableText: "" })
      await settle()
      assert.equal(f.prompt.text, "typed final only")
      assert.equal(f.aborts, 0)
    } finally { await f.dispose() }
  })

  test(`${version}: first transcription key warns, second cancels, late output ignored`, async () => {
    const f = await setup(version, {}, { abort: true })
    try {
      f.toggle(); await settle(); f.toggle(); f.toggle()
      assert.equal(f.aborts, 0)
      assert.match(f.toasts.at(-1).message, /again to cancel/)
      f.toggle()
      assert.equal(f.aborts, 1)
      assert.ok(f.signal.aborted)
      f.toggle(); await settle()
      assert.equal(f.starts, 1)
      await f.callbacks.onStableText("late stable")
      f.result.resolve({ text: "late final", stableText: "" })
      f.abort.resolve(); await settle()
      assert.equal(f.prompt.text, "typed ")
      f.toggle(); await settle()
      assert.equal(f.starts, 2)
    } finally { f.abort.resolve(); await f.dispose() }
  })

  for (const pending of ["support", "start"]) {
    for (const action of ["toggle", "dispose", "navigate"]) {
      test(`${version}: ${action} during pending ${pending} cannot append or leave a late run active`, async () => {
        const f = await setup(version, {}, { [pending]: true })
        try {
          f.toggle(); await settle()
          if (action === "toggle") f.toggle()
          if (action === "dispose") await f.dispose()
          if (action === "navigate") {
            f.route.sessionID = "two"
            await new Promise((resolve) => setTimeout(resolve, 70))
          }
          await settle()
          const count = f.toasts.length
          f[pending].resolve(); await settle()
          await f.callbacks?.onStableText("late")
          assert.equal(f.prompt.text, "typed ")
          assert.equal(f.starts, pending === "support" ? 0 : 1)
          assert.equal(f.aborts, pending === "support" ? 0 : 1)
          assert.equal(f.toasts.length, count)
        } finally { f[pending].resolve(); await f.dispose() }
      })
    }
  }

  for (const phase of ["recording", "transcribing"]) {
    test(`${version}: dispose in ${phase} aborts once, unregisters and suppresses late callbacks`, async () => {
      const f = await setup(version)
      f.toggle(); await settle()
      if (phase === "transcribing") f.toggle()
      await f.dispose()
      const count = f.toasts.length
      f.result.resolve({ text: "late", stableText: "" })
      await f.callbacks.onStableText("late")
      f.toggle(); await settle()
      assert.equal(f.starts, 1)
      assert.equal(f.aborts, 1)
      assert.equal(f.prompt.text, "typed ")
      assert.equal(f.toasts.length, count)
      if (version === "v1") assert.equal(f.unregistered, 1)
    })

    test(`${version}: session change in ${phase} aborts without further input`, async () => {
      const f = await setup(version)
      try {
        f.toggle(); await settle()
        if (phase === "transcribing") f.toggle()
        f.route.sessionID = "two"
        await new Promise((resolve) => setTimeout(resolve, 70))
        assert.equal(f.aborts, 1)
        f.result.resolve({ text: "late", stableText: "" })
        await f.callbacks.onStableText("late"); await settle()
        assert.equal(f.prompt.text, "typed ")
      } finally { await f.dispose() }
    })
  }

  test(`${version}: a cancelled startup completing late cannot overwrite a newer recording`, async () => {
    const f = await setup(version, {}, { start: true })
    try {
      f.toggle(); await settle()
      const oldStart = f.start, oldCallbacks = f.callbacks
      f.toggle(); await settle()
      f.start = deferred()
      f.start.resolve()
      f.toggle(); await settle()
      const count = f.toasts.length
      oldStart.resolve(); await settle()
      await oldCallbacks.onStableText("old")
      await f.callbacks.onStableText("new")
      assert.equal(f.prompt.text, "typed new ")
      assert.equal(f.starts, 2)
      assert.equal(f.aborts, 1)
      assert.equal(f.toasts.length, count)
      f.toggle()
      assert.equal(f.stops, 1)
      f.result.resolve({ text: "new tail", stableText: "new" }); await settle()
      assert.equal(f.prompt.text, "typed new tail ")
    } finally { await f.dispose() }
  })

  test(`${version}: timeout aborts and leaves an observable error toast`, async () => {
    const f = await setup(version)
    f.provider.getFinalTranscriptTimeoutMs = () => 10
    try {
      f.toggle(); await settle(); f.toggle()
      await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(f.aborts, 1)
      assert.equal(f.toasts.at(-1).variant, "error")
      assert.match(f.toasts.at(-1).message, /Timed out/)
      await f.callbacks.onStableText("late")
      assert.equal(f.prompt.text, "typed ")
    } finally { await f.dispose() }
  })

  test(`${version}: default final timeout is 30 seconds`, async (t) => {
    const f = await setup(version)
    t.mock.timers.enable({ apis: ["setTimeout"] })
    try {
      f.toggle(); await settle(); f.toggle()
      t.mock.timers.tick(29_999); await settle()
      assert.equal(f.aborts, 0)
      t.mock.timers.tick(1); await settle()
      assert.equal(f.aborts, 1)
    } finally { t.mock.timers.reset(); await f.dispose() }
  })
}

for (const name of ["voice", "voice2text"]) {
  test(`v2: /${name} remains discoverable in autocomplete and starts recording`, async () => {
    const f = await setup("v2")
    try {
      f.slash(name)
      await settle()
      assert.equal(f.starts, 1)
      assert.match(f.footer(), /Listening/)
      f.key("ctrl+s")
      f.result.resolve({ text: "slash result", stableText: "" })
      await settle()
      assert.equal(f.prompt.text, "typed slash result ")
    } finally { await f.dispose() }
  })
}

test("v2: appends to the live visible composer at end, not search/hidden text or a snapshot", async () => {
  const f = await setup("v2")
  try {
    f.toggle(); await settle()
    const parts = f.prompt.parts
    f.prompt.selection = [1, 3]
    await f.callbacks.onStableText("one")
    assert.equal(f.prompt.text, "typed one ")
    assert.equal(f.prompt.selection, undefined)
    f.prompt.text = "edited in flight "
    f.prompt.cursor = 0
    f.prompt.selection = [2, 5]
    f.toggle()
    f.result.resolve({ text: "one two", stableText: "one" }); await settle()
    assert.equal(f.prompt.text, "edited in flight two ")
    assert.equal(f.prompt.parts, parts)
    assert.equal(f.search.text, "search ")
    assert.equal(f.hidden.text, "hidden ")
  } finally { await f.dispose() }
})

for (const change of ["replace", "destroy", "hide", "route"]) {
  test(`v2: ${change} composer before callback cannot target another prompt`, async () => {
    const f = await setup("v2")
    try {
      f.toggle(); await settle()
      if (change === "replace") {
        f.prompt.parent = null
        f.prompt = editor("replacement ")
        f.prompt.parent = f.container
        f.container.children = [f.prompt]
      }
      if (change === "destroy") f.prompt.isDestroyed = true
      if (change === "hide") f.prompt.visible = false
      if (change === "route") f.route = { type: "plugin" }
      const before = f.prompt.text
      await f.callbacks.onStableText("late"); await settle()
      assert.equal(f.prompt.text, before)
      assert.equal(f.aborts, 1)
    } finally { await f.dispose() }
  })
}

test("v2: no composer is a warning, not microphone startup", async () => {
  const f = await setup("v2")
  try {
    f.prompt.visible = false
    f.toggle(); await settle()
    assert.equal(f.starts, 0)
    assert.equal(f.toasts.at(-1).variant, "warning")
  } finally { await f.dispose() }
})

test("v2: active monitoring and append never traverse unrelated renderer children again", async () => {
  const f = await setup("v2")
  try {
    const unrelated = Array.from({ length: 1000 }, () => ({
      visible: true, isDestroyed: false, parent: f.root,
      getChildren() { f.treeReads++; return [] },
    }))
    f.root.children.unshift(...unrelated)
    f.toggle(); await settle()
    const reads = f.treeReads
    assert.ok(reads >= 1000)
    await new Promise((resolve) => setTimeout(resolve, 120))
    await f.callbacks.onStableText("stable")
    assert.equal(f.treeReads, reads)
    assert.equal(f.prompt.text, "typed stable ")
  } finally { await f.dispose() }
})

for (const end of ["result", "cancel", "dispose", "navigate", "error"]) {
  test(`v2: footer ends on ${end} while voice toasts follow the paused global queue`, async () => {
    const f = await setup("v2")
    try {
      f.showToast({ message: "Unrelated toast", duration: 2500 })
      f.toastPaused = true
      f.showToast({ message: "Already queued", duration: 2500 })
      f.toggle(); await settle()
      assert.match(f.footer(), /Listening/)
      f.toggle()
      assert.match(f.footer(), /Transcribing/)
      assert.doesNotMatch(f.footer(), /Listening/)
      if (end === "result") f.result.resolve({ text: "final", stableText: "" })
      if (end === "cancel") { f.toggle(); f.toggle() }
      if (end === "dispose") await f.dispose()
      if (end === "navigate") {
        f.route.sessionID = "two"
        await new Promise((resolve) => setTimeout(resolve, 70))
      }
      if (end === "error") f.result.reject(new Error("fake ASR failure"))
      await settle()
      assert.equal(f.slots.size, 0)
      assert.equal(f.footer(), "")
      assert.equal(f.currentToast.message, "Unrelated toast")
      assert.equal(f.toastQueue[0].message, "Already queued")
      assert.match(f.toastQueue[1].message, /Listening/)
      assert.equal(f.toastQueue[1].duration, 3_600_000)
      assert.equal(f.toastQueue[2].message, "Transcribing...")
      assert.ok(f.toastQueue.some((toast) => toast.message === " " && toast.duration === 1))
      if (end === "cancel") assert.ok(f.toastQueue.some((toast) => toast.variant === "warning"))
      if (end === "error") assert.ok(f.toastQueue.some((toast) => toast.variant === "error"))
    } finally { await f.dispose() }
  })
}

for (const change of ["hidden ancestor", "destroyed ancestor", "detached ancestor", "different root"]) {
  test(`v2: ${change} cancels the captured prompt without another keypress`, async () => {
    const f = await setup("v2")
    try {
      f.toggle(); await settle()
      if (change === "hidden ancestor") f.container.visible = false
      if (change === "destroyed ancestor") f.container.isDestroyed = true
      if (change === "detached ancestor") f.container.parent = null
      if (change === "different root") f.container.parent = { visible: true, isDestroyed: false, parent: null }
      await new Promise((resolve) => setTimeout(resolve, 70))
      assert.equal(f.aborts, 1)
      await f.callbacks.onStableText("late")
      assert.equal(f.prompt.text, "typed ")
    } finally { await f.dispose() }
  })
}
