/**
 * End-to-end tests for the encoding-aware bash executor: real `bash -c`
 * spawns emitting UTF-16LE (the wsl.exe warning scenario), GBK, and plain
 * UTF-8, asserting the decoded `BashRunResult` text and exit semantics.
 * @module dsh-bash-encoding/tests/executor.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { EncodingBashExecutor } from '../lib/executor.js'

/**
 * A fresh cordis context per executor: `ShellExecutor`'s base constructor
 * registers `ctx.shell` via `provide`, and one service may be registered only
 * once per context.
 */
function makeExecutor(overrides = {}) {
  const ctx = new Context()
  return new EncodingBashExecutor(ctx, {
    cwd: process.cwd(),
    timeoutMs: 15_000,
    maxTimeoutMs: 30_000,
    maxOutputBytes: 64 * 1024,
    graceMs: 1_000,
    ...overrides,
  })
}

test('utf-16le output (wsl warning shape) decodes to correct Chinese', async () => {
  const exec = makeExecutor()
  const msg = 'wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。推荐镜像模式。'
  // The whole stream (message + newline) is UTF-16LE, like wsl.exe writes it.
  const hex = Buffer.from(`${msg}\n`, 'utf16le').toString('hex')
  const result = await exec.run(exec.resolve({
    command: `printf '%s' '${hex}' | xxd -r -p`,
  }))
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, `${msg}\n`)
  assert.equal(result.stdout.truncated, false)
})

test('utf-16le on stderr is decoded and merged into the read', async () => {
  const exec = makeExecutor()
  const msg = '警告：编码测试'
  const hex = Buffer.from(msg, 'utf16le').toString('hex')
  const result = await exec.run(exec.resolve({
    command: `printf '%s' '${hex}' | xxd -r -p >&2`,
  }))
  assert.equal(result.exitCode, 0)
  assert.equal(result.stderr.text, msg)
})

test('plain utf-8 output passes through unchanged', async () => {
  const exec = makeExecutor()
  const result = await exec.run(exec.resolve({ command: 'echo 中文正常输出' }))
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, '中文正常输出\n')
})

test('gbk output decodes correctly', async () => {
  const exec = makeExecutor()
  // GBK bytes for 中文测试 via node: use a hex literal (GBK not in Buffer labels).
  const gbkHex = 'd6d0cec4b2e2cad4' // 中文测试
  const result = await exec.run(exec.resolve({
    command: `printf '%s' '${gbkHex}' | xxd -r -p; echo`,
  }))
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, '中文测试\n')
})

test('nonzero exit resolves with code and empty text', async () => {
  const exec = makeExecutor()
  const result = await exec.run(exec.resolve({ command: 'exit 3' }))
  assert.equal(result.exitCode, 3)
  assert.equal(result.stdout.text, '')
})

test('stdin is delivered to the command', async () => {
  const exec = makeExecutor()
  const result = await exec.run(exec.resolve({
    command: 'cat',
    stdin: 'hello-stdin',
  }))
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout.text, 'hello-stdin')
})

test('timeout kills the process and reports timedOut', async () => {
  const exec = makeExecutor({ timeoutMs: 300 })
  const result = await exec.run(exec.resolve({ command: 'sleep 5' }))
  assert.equal(result.timedOut, true)
  assert.equal(result.aborted, false)
  assert.notEqual(result.exitCode, 0)
})

test('background start/readOutput/kill lifecycle', async () => {
  const exec = makeExecutor()
  const proc = exec.start(exec.resolve({ command: 'echo bg-out; sleep 0.2; echo bg-later' }))
  assert.equal(proc.status, 'running')
  await new Promise((r) => setTimeout(r, 350))
  await proc.done
  assert.equal(proc.exitCode, 0)
  const read = proc.readOutput()
  assert.ok(read.delta.includes('bg-out'))
  assert.ok(read.delta.includes('bg-later'))
})

test('spawn failure settles as killed with error text', async () => {
  const exec = makeExecutor()
  // A bogus cwd makes the spawn fail cleanly.
  const result = await exec.run(exec.resolve({
    command: 'echo never',
    workdir: '/definitely/not/a/real/dir-xyz',
  }))
  assert.equal(result.exitCode, null)
  assert.ok(result.stderr.text.includes('spawn failed'))
})
