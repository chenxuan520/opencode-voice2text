import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { test } from "node:test"
import { readFile } from "node:fs/promises"

const run = (args) => promisify(execFile)(process.execPath, [new URL("../dist/cli.js", import.meta.url).pathname, ...args])

test("standalone CLI: help/version/invalid options do not require a TUI runtime or start recording", async () => {
  const help = await run(["--help"])
  assert.match(help.stdout, /--toggle-key/)
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
  assert.match((await run(["--version"])).stdout, new RegExp(version.replaceAll(".", "\\.")))
  await assert.rejects(run(["--invalid-test-option"]), (error) => {
    assert.match(error.stderr, /Unknown option/)
    return true
  })
})

test("standalone CLI: fake one-shot recognition prints stable text and only final tail", async () => {
  for (const args of [[], ["--no-trailing-space"]]) {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--experimental-test-module-mocks", "--import", new URL("./fixtures/cli-runtime.mjs", import.meta.url).href,
      new URL("../dist/cli.js", import.meta.url).pathname, ...args,
    ])
    assert.equal(stdout, args.length ? "helloworld" : "hello world ")
  }
})
