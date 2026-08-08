/**
 * Encoding detection and decoding core for `dsh-bash-encoding`.
 *
 * Zero-dependency, pure functions over raw bytes. The bash subprocess seam
 * decodes every stream as UTF-8 (`Buffer.toString('utf8')`), which turns
 * UTF-16LE output — e.g. wsl.exe's localhost-proxy warning on Windows — into
 * unrecoverable mojibake (`�hKm0R …`). This module re-decodes the raw bytes
 * this plugin captures itself, before any lossy conversion happens.
 *
 * Detection order (per chunk):
 * 1. BOM (UTF-8 / UTF-16LE / UTF-16BE).
 * 2. NUL-byte parity heuristic for BOM-less UTF-16.
 * 3. Strict UTF-8 validation (fatal decoder).
 * 4. GBK, then GB18030, as the CJK legacy fallback (Windows OEM codepages
 *    936/54936 for Chinese tools).
 * 5. Latin-1 as the last resort (never fails; better than mojibake).
 *
 * Chunk-level streaming: a real child stream can interleave encodings —
 * wsl.exe writes its UTF-16LE proxy warning as one complete write, then the
 * command's own UTF-8 output follows on the same pipe. Detecting the whole
 * concatenated stream as one encoding mangles whichever part is in the other
 * encoding, so {@link ChunkDecoder} detects each pipe write independently,
 * keeps UTF-8 multi-byte state across chunks via `{ stream: true }`, and
 * carries an odd UTF-16 trailing byte to the next chunk for pairing.
 *
 * @module @dsh-external/dsh-bash-encoding/decode-core
 */

/** Encodings this core can emit. */
export type DetectedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gbk' | 'gb18030' | 'latin1'

/** Result of decoding one byte stream. */
export interface DecodeResult {
  /** The decoded text. */
  text: string
  /** The encoding that produced the text. */
  encoding: DetectedEncoding
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const
const UTF16LE_BOM = [0xff, 0xfe] as const
const UTF16BE_BOM = [0xfe, 0xff] as const

const REPLACEMENT = '\ufffd'

/**
 * Strict UTF-8 validation: any invalid sequence (including lone continuation
 * bytes and overlong forms) throws. Used as a positive check only — every
 * valid UTF-8 stream passes, so the `catch` names the single failure mode.
 */
function isStrictUtf8(buffer: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

/**
 * Score BOM-less UTF-16 by NUL-byte parity: in UTF-16LE every ASCII code
 * unit is `0xXX 0x00` (NUL at odd offsets), in UTF-16BE `0x00 0xXX` (NUL at
 * even offsets). Returns `'utf-16le' | 'utf-16be' | null`.
 */
function detectUtf16ByNuls(buffer: Buffer): 'utf-16le' | 'utf-16be' | null {
  if (buffer.length < 4) return null
  let evenNuls = 0
  let oddNuls = 0
  // Sample the first 256 bytes; a full scan is unnecessary for a heuristic.
  const limit = Math.min(buffer.length & ~1, 256)
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) {
      if (i % 2 === 0) evenNuls++
      else oddNuls++
    }
  }
  const total = evenNuls + oddNuls
  if (total < 4) return null // not enough NULs to be plausibly UTF-16
  if (oddNuls / total >= 0.8) return 'utf-16le'
  if (evenNuls / total >= 0.8) return 'utf-16be'
  return null
}

/**
 * CJK code-unit range check: for UTF-16LE, the HIGH byte (odd offset) of a
 * CJK unified ideograph (U+4E00..U+9FFF) sits in 0x4E..0x9F; for UTF-16BE
 * that high byte sits at even offsets. Pure-CJK UTF-16 streams carry no NUL
 * bytes, so this distribution heuristic catches what the NUL parity misses.
 * Returns `'utf-16le' | 'utf-16be' | null`.
 *
 * Only ONE side needs the high-byte majority: the low byte of a UTF-16 code
 * unit is arbitrary and may itself land in 0x4E..0x9F, so a cross-side cap
 * would reject valid streams. GBK lead/trail bytes (0xB0..0xF7 / 0xA1..0xFE)
 * and UTF-8 lead bytes (0xE4..0xE9) all fall outside the range, so a 0.6
 * majority on one side is a strong UTF-16 signature; when both sides reach
 * it the stream is ambiguous and null is returned (rare).
 */
function detectUtf16ByCjkHighBytes(buffer: Buffer): 'utf-16le' | 'utf-16be' | null {
  if (buffer.length < 8) return null
  // Only whole code units are scored: an odd trailing byte must not count its
  // lone byte as a low byte (it would skew the even-side ratio).
  const limit = Math.min(buffer.length & ~1, 256)
  let oddCjk = 0
  let evenCjk = 0
  for (let i = 0; i < limit; i += 2) {
    const b0 = buffer[i]
    const b1 = buffer[i + 1]
    if (b1 >= 0x4e && b1 <= 0x9f) oddCjk++ // odd offset = high byte in LE
    if (b0 >= 0x4e && b0 <= 0x9f) evenCjk++ // even offset = high byte in BE
  }
  const pairs = Math.floor(limit / 2)
  if (pairs === 0) return null
  const oddRatio = oddCjk / pairs
  const evenRatio = evenCjk / pairs
  if (oddRatio >= 0.6 && evenRatio < 0.6) return 'utf-16le'
  if (evenRatio >= 0.6 && oddRatio < 0.6) return 'utf-16be'
  return null
}

/**
 * Decode with a legacy single- or double-byte CJK codec and accept it when
 * no replacement characters remain (the codec maps every byte pair).
 * @param buffer - the raw bytes.
 * @param encoding - the TextDecoder label to try.
 * @returns the decoded text, or null when it still contains U+FFFD.
 */
function tryLegacyDecode(buffer: Buffer, encoding: 'gbk' | 'gb18030'): string | null {
  const text = new TextDecoder(encoding).decode(buffer)
  return text.includes(REPLACEMENT) ? null : text
}

/**
 * Detect the encoding of one raw byte chunk. Chunk-level, not stream-level:
 * a chunk is assumed to be a single pipe write, which is the granularity at
 * which wsl.exe emits its UTF-16LE warning vs. the command's UTF-8 output.
 * @param buffer - raw captured bytes (may be empty).
 * @returns the detected encoding.
 */
export function detectEncoding(buffer: Buffer): DetectedEncoding {
  if (buffer.length === 0) return 'utf-8'
  if (buffer.length >= 3 && buffer[0] === UTF8_BOM[0] && buffer[1] === UTF8_BOM[1] && buffer[2] === UTF8_BOM[2]) {
    return 'utf-8'
  }
  if (buffer.length >= 2 && buffer[0] === UTF16LE_BOM[0] && buffer[1] === UTF16LE_BOM[1]) return 'utf-16le'
  if (buffer.length >= 2 && buffer[0] === UTF16BE_BOM[0] && buffer[1] === UTF16BE_BOM[1]) return 'utf-16be'
  const utf16 = detectUtf16ByNuls(buffer) ?? detectUtf16ByCjkHighBytes(buffer)
  if (utf16 !== null) return utf16
  if (isStrictUtf8(buffer)) return 'utf-8'
  // GBK first (the common Windows-Chinese OEM codepage); GB18030 is a strict
  // superset that also maps every byte sequence, so it catches the rest.
  const gbk = tryLegacyDecode(buffer, 'gbk')
  if (gbk !== null) return 'gbk'
  return 'gb18030'
}

/** Strip a leading BOM from the buffer for the matching encoding. */
function stripBom(buffer: Buffer, encoding: DetectedEncoding): Buffer {
  if (encoding === 'utf-8' && buffer.length >= 3 && buffer[0] === UTF8_BOM[0] && buffer[1] === UTF8_BOM[1] && buffer[2] === UTF8_BOM[2]) {
    return buffer.subarray(3)
  }
  if ((encoding === 'utf-16le' || encoding === 'utf-16be') && buffer.length >= 2
    && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    return buffer.subarray(2)
  }
  return buffer
}

/**
 * Decode one complete byte chunk with automatic encoding detection.
 * @param buffer - raw captured bytes.
 * @returns the decoded text and the encoding that produced it.
 */
export function decodeBuffer(buffer: Buffer): DecodeResult {
  const encoding = detectEncoding(buffer)
  return { text: decodeChunkBody(buffer, encoding), encoding }
}

/** Decode one chunk body after detection; the shared tail of decodeBuffer and ChunkDecoder. */
function decodeChunkBody(buffer: Buffer, encoding: DetectedEncoding): string {
  const body = stripBom(buffer, encoding)
  if (encoding === 'utf-8') return new TextDecoder('utf-8').decode(body)
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    // A trailing odd byte is half a code unit (e.g. a lone `\n` appended after
    // a UTF-16 stream); drop it instead of emitting U+FFFD.
    const trimmed = body.length % 2 !== 0 ? body.subarray(0, body.length - 1) : body
    return new TextDecoder(encoding).decode(trimmed)
  }
  if (encoding === 'gbk' || encoding === 'gb18030') {
    const text = tryLegacyDecode(body, encoding)
    if (text !== null) return text
  }
  return body.toString('latin1')
}

/**
 * Streaming decoder for an interleaved-encoding child stream. One instance
 * per captured stream; feed raw pipe chunks with {@link ChunkDecoder.push}
 * and read the accumulated text with {@link ChunkDecoder.text}.
 *
 * Cross-chunk state:
 * - UTF-8 multi-byte sequences: kept by a `{ stream: true }` TextDecoder, so
 *   a character split across pipe writes reassembles without U+FFFD.
 * - UTF-16 odd trailing byte: retained and prepended to the next chunk when
 *   that chunk also detects as UTF-16; dropped when the next chunk is not
 *   UTF-16 (it was noise, not half a code unit).
 */
export class ChunkDecoder {
  /**
   * Streaming UTF-8 decoder; carries incomplete sequences across chunks.
   * `stream: true` is a WHATWG TextDecoder option; the bundled @types/node
   * labels it narrowly, so the cast documents runtime support.
   */
  private readonly utf8 = new TextDecoder('utf-8', { stream: true } as unknown as { fatal?: boolean; ignoreBOM?: boolean; stream?: boolean })
  /** An odd UTF-16 trailing byte awaiting its pair in the next chunk. */
  private pendingUtf16Tail: Buffer | undefined
  /**
   * Sticky UTF-16 mode: once a stream detects as UTF-16 (wsl.exe's warning),
   * later chunks are decoded as UTF-16 until a chunk provides strong evidence
   * of another encoding (strict UTF-8 with a low NUL ratio). A long UTF-16
   * stream can be split across pipe writes, and each fragment alone may be
   * too short for the detection heuristics.
   */
  private utf16Mode: 'utf-16le' | 'utf-16be' | undefined
  /** Decoded output accumulated so far. */
  private out = ''

  /** Push one raw pipe chunk; appends its decoded text. */
  push(chunk: Buffer): void {
    if (chunk.length === 0) return
    const effective = this.pendingUtf16Tail !== undefined
      ? Buffer.concat([this.pendingUtf16Tail, chunk])
      : chunk

    // Sticky mode: prefer UTF-16 unless the chunk is unambiguous UTF-8.
    if (this.utf16Mode !== undefined) {
      // Strong exit evidence: strict UTF-8 with few NUL bytes (a UTF-16 ASCII
      // fragment carries a NUL after every character; real UTF-8 text has none).
      if (this.pendingUtf16Tail === undefined && isStrictUtf8(chunk) && nulRatio(chunk) < 0.1) {
        this.utf16Mode = undefined
        this.out += this.utf8.decode(chunk)
        return
      }
      this.pendingUtf16Tail = undefined
      const body = stripBom(effective, this.utf16Mode)
      const odd = body.length % 2 !== 0
      const complete = odd ? body.subarray(0, body.length - 1) : body
      if (odd) this.pendingUtf16Tail = Buffer.from([body[body.length - 1]])
      this.out += new TextDecoder(this.utf16Mode).decode(complete)
      return
    }

    const encoding = detectEncoding(effective)
    if (encoding === 'utf-16le' || encoding === 'utf-16be') {
      this.utf16Mode = encoding
      this.pendingUtf16Tail = undefined
      const body = stripBom(effective, encoding)
      // Keep an odd tail for the next chunk; decode the even prefix now.
      const odd = body.length % 2 !== 0
      const complete = odd ? body.subarray(0, body.length - 1) : body
      if (odd) this.pendingUtf16Tail = Buffer.from([body[body.length - 1]])
      this.out += new TextDecoder(encoding).decode(complete)
      return
    }
    // Not UTF-16: the pending tail, if any, was noise — drop it and decode
    // the current chunk as-is. UTF-8 streams carry their own cross-chunk state.
    this.pendingUtf16Tail = undefined
    if (encoding === 'utf-8') {
      this.out += this.utf8.decode(chunk)
      return
    }
    if (encoding === 'gbk' || encoding === 'gb18030') {
      const text = tryLegacyDecode(chunk, encoding)
      this.out += text ?? chunk.toString('latin1')
      return
    }
    this.out += chunk.toString('latin1')
  }

  /** Flush trailing decoder state (call once when the stream closes). */
  flush(): void {
    this.out += this.utf8.decode()
    this.pendingUtf16Tail = undefined
    this.utf16Mode = undefined
  }

  /** The decoded text accumulated so far. */
  get text(): string {
    return this.out
  }
}

/** Fraction of NUL bytes in the chunk (0..1). */
function nulRatio(buffer: Buffer): number {
  if (buffer.length === 0) return 0
  let nuls = 0
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) nuls++
  }
  return nuls / buffer.length
}
