/**
 * Tests for the encoding detection core: BOMs, BOM-less UTF-16 heuristics,
 * strict UTF-8, GBK/GB18030 legacy fallbacks, and the WSL mojibake scenario.
 * @module dsh-bash-encoding/tests/decode-core.test
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ChunkDecoder, decodeBuffer, detectEncoding } from '../lib/decode-core.js'

test('utf-8 with BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中文 hello', 'utf8')])
  assert.equal(detectEncoding(buf), 'utf-8')
  assert.equal(decodeBuffer(buf).text, '中文 hello')
})

test('plain utf-8 without BOM', () => {
  const buf = Buffer.from('普通中文输出 hello', 'utf8')
  assert.equal(detectEncoding(buf), 'utf-8')
  assert.equal(decodeBuffer(buf).text, '普通中文输出 hello')
})

test('utf-16le with BOM', () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('中文测试', 'utf16le')])
  assert.equal(detectEncoding(buf), 'utf-16le')
  assert.equal(decodeBuffer(buf).text, '中文测试')
})

test('utf-16be with BOM', () => {
  // Node's Buffer.from has no 'utf16be' label; byte-swap utf16le output.
  const le = Buffer.from('中文测试', 'utf16le')
  const be = Buffer.alloc(le.length)
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1]
    be[i + 1] = le[i]
  }
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), be])
  assert.equal(detectEncoding(buf), 'utf-16be')
  assert.equal(decodeBuffer(buf).text, '中文测试')
})

test('bom-less utf-16le detected via NUL parity (WSL warning shape)', () => {
  const msg = 'wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。推荐镜像模式。'
  const buf = Buffer.from(msg, 'utf16le')
  assert.equal(detectEncoding(buf), 'utf-16le')
  assert.equal(decodeBuffer(buf).text, msg)
})

test('pure-ascii stream stays utf-8', () => {
  const buf = Buffer.from('hello world\n')
  assert.equal(detectEncoding(buf), 'utf-8')
  assert.equal(decodeBuffer(buf).text, 'hello world\n')
})

test('gbk bytes decode as gbk (not utf-8 mojibake)', () => {
  const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4, 0x0a]) // 中文测试\n in GBK
  assert.equal(detectEncoding(buf), 'gbk')
  assert.equal(decodeBuffer(buf).text, '中文测试\n')
})

test('gb18030 bytes decode as gb18030', () => {
  // 中文 in GB18030 (identical to GBK for BMP; exercise the fallback path)
  const buf = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  const result = decodeBuffer(buf)
  assert.equal(result.text, '中文')
  assert.ok(result.encoding === 'gbk' || result.encoding === 'gb18030')
})

test('empty buffer decodes to empty text', () => {
  const buf = Buffer.alloc(0)
  assert.equal(detectEncoding(buf), 'utf-8')
  assert.equal(decodeBuffer(buf).text, '')
})

test('short ascii with trailing newline', () => {
  const buf = Buffer.from('ok\n')
  assert.equal(detectEncoding(buf), 'utf-8')
  assert.equal(decodeBuffer(buf).text, 'ok\n')
})

test('latin1 fallback never throws on arbitrary bytes', () => {
  // 0x80-0xFF with no valid legacy mapping shape: must not throw.
  const buf = Buffer.from([0x80, 0xff, 0xfe, 0x81, 0x0a])
  const result = decodeBuffer(buf)
  assert.equal(typeof result.text, 'string')
  assert.ok(result.text.length > 0)
})

// ── ChunkDecoder: interleaved-encoding streams ──────────────────────────────

test('chunk decoder: utf-16le warning write then utf-8 output (real wsl.exe shape)', () => {
  const d = new ChunkDecoder()
  d.push(Buffer.from('wsl: 检测到 localhost 代理配置\n', 'utf16le'))
  d.push(Buffer.from('命令自己的中文输出 hello\n', 'utf8'))
  d.flush()
  assert.equal(d.text, 'wsl: 检测到 localhost 代理配置\n命令自己的中文输出 hello\n')
})

test('chunk decoder: utf-8 multibyte character split across chunks', () => {
  const d = new ChunkDecoder()
  const s = '跨chunk的中文字符'
  const b = Buffer.from(s, 'utf8')
  d.push(b.subarray(0, 7)) // cuts through a CJK character
  d.push(b.subarray(7))
  d.flush()
  assert.equal(d.text, s)
})

test('chunk decoder: long utf-16 stream split across many small chunks', () => {
  const d = new ChunkDecoder()
  const long = '这是一段比较长的 UTF-16 消息，会被管道切成多个片段，每个片段单独到达'
  const b = Buffer.from(long, 'utf16le')
  for (let i = 0; i < b.length; i += 11) {
    d.push(b.subarray(i, Math.min(i + 11, b.length)))
  }
  d.flush()
  assert.equal(d.text, long)
})

test('chunk decoder: utf-16 tail byte carried across chunk boundary', () => {
  const d = new ChunkDecoder()
  // First chunk must be large enough for detection; then split oddly.
  const msg = '中文测试消息'
  const b = Buffer.from(msg, 'utf16le')
  d.push(b.subarray(0, b.length - 1)) // odd length: last byte is half a code unit
  d.push(b.subarray(b.length - 1))
  d.flush()
  assert.equal(d.text, msg)
})

test('chunk decoder: plain utf-8 stream passes through', () => {
  const d = new ChunkDecoder()
  d.push(Buffer.from('普通中文输出\n'))
  d.push(Buffer.from('第二行 hello\n'))
  d.flush()
  assert.equal(d.text, '普通中文输出\n第二行 hello\n')
})

test('chunk decoder: empty chunks are no-ops', () => {
  const d = new ChunkDecoder()
  d.push(Buffer.alloc(0))
  d.push(Buffer.from('ok'))
  d.flush()
  assert.equal(d.text, 'ok')
})
