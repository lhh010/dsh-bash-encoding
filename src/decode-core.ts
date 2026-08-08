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
 * Whether the buffer contains only ASCII printable (0x20..0x7E) and control
 * (0x00..0x1F, 0x7F) bytes — i.e. no high bytes at all. Such text is UTF-8
 * by construction; UTF-16 would interleave NUL bytes into a different
 * pattern and the CJK heuristics cannot separate ASCII letters from UTF-16
 * CJK low bytes.
 */
function isPureAscii(buffer: Buffer): boolean {
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i]
    if (b > 0x7f) return false
  }
  return true
}

/**
 * A CJK high-byte hit for UTF-16: the byte is in 0x4E..0x9F. The low byte
 * is NOT constrained here — UTF-16 CJK low bytes are arbitrary and may be
 * printable ASCII (e.g. 个 = U+4E2A has low byte 0x2A '*'). Plain-ASCII
 * lookalikes are excluded at the aggregate level instead: ASCII letters put
 * BOTH parities in the range, so the high side must dominate by a margin.
 * @param highByte - the code unit's high byte (odd offset for LE).
 */
function isCjkHighByte(highByte: number): boolean {
  return highByte >= 0x4e && highByte <= 0x9f
}

/**
 * Whether a code unit is UTF-16-shaped at the byte level:
 * - high byte NUL (ASCII UTF-16 `XX 00`);
 * - high byte above 0x7E (CJK high range 0x80..0x9F — plain ASCII never
 *   has such a byte, so this is an unambiguous UTF-16 signature);
 * - high byte in 0x4E..0x7E with a low byte above 0x7E (a CJK code unit
 *   whose high byte is printable ASCII).
 * A plain-ASCII letter pair (`STDERR`, `hello`) never satisfies any arm;
 * a CJK code unit like 到=0x5230 (low 0x30) falls through as an isolated
 * miss the run threshold tolerates.
 */
function isUtf16Unit(highByte: number, lowByte: number): boolean {
  if (highByte === 0) return true
  if (highByte > 0x7e) return true
  return highByte >= 0x4e && lowByte > 0x7e
}

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
 * Three guards separate UTF-16 from lookalikes:
 * - The high side must dominate (>= 0.6) while the low side stays low
 *   (<= 0.55): plain ASCII letters hit BOTH sides (e.g. `hello` = 1.0/1.0),
 *   so a high-side majority alone is not a UTF-16 signature.
 * - UTF-8 lead bytes (0xE4..0xE9) anywhere disqualify the stream: UTF-8
 *   Chinese emits one every three bytes, UTF-16 never does.
 * - GBK lead/trail bytes (0xB0..0xF7 / 0xA1..0xFE) never hit the range.
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
    if (isCjkHighByte(b1)) oddCjk++ // odd offset = high byte in LE
    if (isCjkHighByte(b0)) evenCjk++ // even offset = high byte in BE
  }
  const pairs = Math.floor(limit / 2)
  if (pairs === 0) return null
  const oddRatio = oddCjk / pairs
  const evenRatio = evenCjk / pairs
  // The high side must dominate by a margin: plain ASCII letters hit BOTH
  // sides (e.g. `hello` ≈ 1.0/1.0, difference ≈ 0), while UTF-16 CJK
  // concentrates high bytes on one side (low bytes are arbitrary).
  if (oddRatio >= 0.6 && oddRatio - evenRatio >= 0.1) return 'utf-16le'
  if (evenRatio >= 0.6 && evenRatio - oddRatio >= 0.1) return 'utf-16be'
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
  // Pure ASCII (printable + control bytes only) is UTF-8 by construction:
  // UTF-16 would interleave NULs, and the CJK high-byte heuristics cannot
  // reliably separate ASCII letters from UTF-16 CJK code units.
  if (isPureAscii(buffer)) return 'utf-8'
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
 * A pipe write may merge encodings into ONE chunk: wsl.exe's UTF-16LE warning
 * and the command's UTF-8 output frequently arrive in the same read, so
 * per-chunk detection alone is insufficient. The decoder therefore scans
 * WITHIN each effective buffer for encoding segments:
 *
 * - A UTF-16 segment is anchored by its ASCII portion: in UTF-16LE every
 *   ASCII code unit is `XX 00` (NUL at odd offsets); in UTF-16BE `00 XX`
 *   (NUL at even offsets). Dense odd/even NUL runs mark the segment's
 *   start, and the segment extends while the NUL pattern (or pure-CJK
 *   high-byte pattern) holds.
 * - The remainder of the buffer is decoded as a normal (UTF-8/GBK) segment.
 *
 * Cross-chunk state:
 * - UTF-8 multi-byte sequences: kept by a `{ stream: true }` TextDecoder, so
 *   a character split across pipe writes reassembles without U+FFFD.
 * - UTF-16 odd trailing byte: retained and prepended to the next chunk when
 *   that chunk still begins with UTF-16; dropped otherwise.
 * - A UTF-16 segment cut by the chunk boundary is finished in the next push
 *   via the sticky UTF-16 mode.
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
   * Sticky UTF-16 mode: once a UTF-16 segment is open (its final byte may
   * have been cut by the chunk boundary), the next push continues it until
   * strong evidence of another encoding appears.
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

    // Sticky UTF-16 continuation: the previous push ended mid-segment.
    if (this.utf16Mode !== undefined) {
      const encoding = this.utf16Mode
      // Find where the UTF-16 pattern breaks inside this buffer.
      const seg = utf16SegmentEnd(effective, encoding, 0, true)
      const { end, isOpen } = seg
      this.decodeUtf16(effective.subarray(0, end), encoding)
      if (isOpen) {
        // The whole buffer is still UTF-16; keep the mode (and possibly a tail).
        return
      }
      this.utf16Mode = undefined
      // The remainder is a normal segment; fall through to segment scan.
      const rest = effective.subarray(end)
      if (rest.length > 0) this.pushNormal(rest)
      return
    }

    this.pushNormal(effective)
  }

  /** Decode one buffer that may interleave a UTF-16 segment and normal text. */
  private pushNormal(buffer: Buffer): void {
    let pos = 0
    while (pos < buffer.length) {
      const seg = findUtf16Segment(buffer, pos)
      if (seg === undefined) break
      const { start, end, encoding, isOpen } = seg
      // Text before the segment start is a normal segment.
      if (start > pos) this.decodeNormal(buffer.subarray(pos, start))
      this.decodeUtf16(buffer.subarray(start, end), encoding)
      if (isOpen) {
        this.utf16Mode = encoding
        return
      }
      pos = end
    }
    // Trailing text after the last segment (or the whole buffer).
    this.decodeNormal(buffer.subarray(pos))
  }

  /** Decode a UTF-16 slice, carrying an odd trailing byte across pushes. */
  private decodeUtf16(body: Buffer, encoding: 'utf-16le' | 'utf-16be'): void {
    // The caller merged any carried tail into `body`; clear it unconditionally
    // so a consumed tail cannot leak into the next push.
    this.pendingUtf16Tail = undefined
    const odd = body.length % 2 !== 0
    const complete = odd ? body.subarray(0, body.length - 1) : body
    if (odd) this.pendingUtf16Tail = Buffer.from([body[body.length - 1]])
    this.out += new TextDecoder(encoding).decode(complete)
  }

  /** Decode a normal (non-UTF-16) slice with encoding detection. */
  private decodeNormal(buffer: Buffer): void {
    if (buffer.length === 0) return
    const encoding = detectEncoding(buffer)
    if (encoding === 'utf-8') {
      this.out += this.utf8.decode(buffer)
      return
    }
    if (encoding === 'gbk' || encoding === 'gb18030') {
      const text = tryLegacyDecode(buffer, encoding)
      this.out += text ?? buffer.toString('latin1')
      return
    }
    this.out += buffer.toString('latin1')
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

/** Fraction of NUL bytes in the buffer (0..1). */
function nulRatio(buffer: Buffer): number {
  if (buffer.length === 0) return 0
  let nuls = 0
  for (let i = 0; i < buffer.length; i++) {
    if (buffer[i] === 0) nuls++
  }
  return nuls / buffer.length
}

/**
 * Locate the next UTF-16 segment starting at or after `from` inside one
 * buffer. Anchors on a dense run of parity-aligned NUL bytes (the ASCII
 * portion of a UTF-16 stream) and extends through pure-CJK code units
 * (high byte in 0x4E..0x9F, no NULs) and punctuation (any high byte) while
 * the code-unit pattern holds.
 *
 * Termination distinguishes UTF-8 Chinese from UTF-16 Chinese: UTF-8 CJK
 * bytes come in 3-byte groups whose odd-position bytes only sporadically
 * fall in the CJK high range (`C..C..`), whereas UTF-16 CJK code units
 * produce consecutive high-byte hits (`CCCC`). The segment therefore ends
 * at the first run of two consecutive code units with no NUL and no CJK
 * high byte — a signature UTF-8 Chinese text cannot produce.
 * @param buffer - the buffer to scan.
 * @param from - byte offset to start scanning at.
 * @returns the segment's start/end offsets, its encoding, and whether the
 * segment is open at the buffer end (cut by the chunk boundary).
 */
function findUtf16Segment(
  buffer: Buffer,
  from: number,
): { start: number; end: number; encoding: 'utf-16le' | 'utf-16be'; isOpen: boolean } | undefined {
  const limit = buffer.length
  if (limit - from < 8) return undefined
  // Try both byte orders; pick the parity with the denser anchor.
  for (const encoding of ['utf-16le', 'utf-16be'] as const) {
    const nulParity = encoding === 'utf-16le' ? 1 : 0
    // Anchor: in the first 8 code units from `from`, either at least 3 NULs
    // (ASCII UTF-16) or a 0.6 CJK-high-byte majority (pure-CJK UTF-16) with
    // no UTF-8 lead byte (0xE4..0xE9) at the opposite offset, which UTF-8
    // Chinese emits every three bytes and UTF-16 never does.
    const anchorUnits = Math.min(8, Math.floor((limit - from) / 2))
    let anchorNuls = 0
    let anchorCjk = 0
    let anchorLow = 0
    let anchorLead = 0
    for (let u = 0; u < anchorUnits; u++) {
      const off = from + u * 2
      const highByte = nulParity === 1 ? buffer[off + 1] : buffer[off]
      const lowByte = nulParity === 1 ? buffer[off] : buffer[off + 1]
      if (highByte === 0) anchorNuls++
      else if (isCjkHighByte(highByte)) anchorCjk++
      if (isCjkHighByte(lowByte)) anchorLow++
      // Only a lead byte at the HIGH position vetoes the anchor: a UTF-16
      // high byte never falls in 0xE4..0xE9, while a UTF-16 LOW byte often
      // does (跨=0x8DE8) and must not disqualify the window.
      if (nulParity === 1
        ? (buffer[off + 1] >= 0xe4 && buffer[off + 1] <= 0xe9)
        : (buffer[off] >= 0xe4 && buffer[off] <= 0xe9)) anchorLead++
    }
    const hasNulAnchor = anchorNuls >= 3
    // Pure-ASCII windows are never UTF-16 segments (UTF-16 would interleave
    // NULs into the anchor), so skip the CJK anchor for them outright.
    const anchorWindow = buffer.subarray(from, from + anchorUnits * 2)
    const hasCjkAnchor = !isPureAscii(anchorWindow)
      && anchorCjk / anchorUnits >= 0.6
      // The high side should dominate somewhat: plain-ASCII letters hit BOTH
      // sides equally (e.g. `hello` ≈ 1.0/1.0), while UTF-16 CJK high bytes
      // concentrate on one side. A small margin suffices — low bytes of CJK
      // code units frequently land in 0x4E..0x9F too (一段非常长的: lows
      // 0x5E/0x38/0x7F/0x84), so 0.25 rejected valid windows.
      && (anchorCjk - anchorLow) / anchorUnits >= 0.1
      && anchorLead === 0
    if (!hasNulAnchor && !hasCjkAnchor) continue
    // Extend code unit by code unit; end at a run of non-UTF16 units
    // (punctuation like ，。！ is allowed in short runs) or at an opposite-
    // offset UTF-8 lead byte (0xE4..0xE9), which UTF-16 never produces.
    let end = from + anchorUnits * 2
    let misses = 0
    // The segment ends at the LAST HIT: miss code units are not part of the
    // UTF-16 segment and must not be decoded as UTF-16.
    let lastHitEnd = end
    let asciiRun = 0
    while (end + 1 < limit) {
      const b0 = buffer[end]
      const b1 = buffer[end + 1]
      // Extension is TRUSTING (the anchor already established UTF-16): any
      // high byte in the CJK range extends the segment — 片=0x7247 has high
      // 0x72, 到=0x5230 high 0x52, 段=0x6BB5 high 0x6B — these are common
      // CJK high bytes even though they look like ASCII letters.
      const highByte = nulParity === 1 ? b1 : b0
      const lowByte = nulParity === 1 ? b0 : b1
      const hit = highByte === 0 || isCjkHighByte(highByte)
      // A run of printable-ASCII code units (both bytes 0x20..0x7E) is
      // plain ASCII text, not UTF-16: `STDERR: ` is 4 such units in a row,
      // while CJK code units break the run (段=0x6BB5 has byte 0xB5) and
      // UTF-16 ASCII has a NUL high byte (l\0 is not printable-pair).
      const asciiUnit = (b0 >= 0x20 && b0 <= 0x7e) && (b1 >= 0x20 && b1 <= 0x7e)
      // UTF-8 hard breaks:
      // 1. A lead byte (0xE4..0xE9) at the HIGH-BYTE position — a UTF-16
      //    high byte never falls there.
      // 2. The three-byte signature: lead (0xE4..0xE9) at the LOW position
      //    with the current high byte and the next low byte both being
      //    continuations (0x80..0xBF).
      const highIsLead = nulParity === 1
        ? (b1 >= 0xe4 && b1 <= 0xe9)
        : (b0 >= 0xe4 && b0 <= 0xe9)
      if (highIsLead) break
      if (end + 3 < limit) {
        const nextLow = nulParity === 1 ? buffer[end + 2] : buffer[end + 3]
        const curHighCont = (nulParity === 1 ? b1 : b0) >= 0x80 && (nulParity === 1 ? b1 : b0) <= 0xbf
        const lowIsLead = nulParity === 1
          ? (b0 >= 0xe4 && b0 <= 0xe9)
          : (b1 >= 0xe4 && b1 <= 0xe9)
        const continuation = (b: number): boolean => b >= 0x80 && b <= 0xbf
        if (lowIsLead && curHighCont && continuation(nextLow)) break
      }
      if (asciiUnit) {
        asciiRun++
        end += 2
        lastHitEnd = end
        // A run of 4+ printable-ASCII code units is plain ASCII text
        // (`STDERR: `), not UTF-16: roll the segment back to the run start.
        // Runs of 1-3 are tolerated — CJK code units whose bytes all happen
        // to be printable (个=0x4E2A, 片=0x7247) are common and the run is
        // broken by the next non-ASCII unit (段=0x6BB5).
        if (asciiRun >= 4) {
          lastHitEnd = end - asciiRun * 2
          break
        }
        continue
      }
      asciiRun = 0
      if (hit) {
        misses = 0
        end += 2
        lastHitEnd = end
      } else {
        misses++
        if (misses >= 4) break
        end += 2
      }
    }
    if (end - from < 4) continue
    // The segment ends at the last hit; miss code units belong to the next
    // (normal) segment. OPEN only when the buffer boundary cut the segment
    // mid-stream: ran out of bytes AND the consumed length is odd — half a
    // code unit awaiting its pair in the next push. A segment that consumed
    // a whole even-length run is complete; marking it open would make
    // pushNormal swallow the remaining content until the next push.
    const segEnd = Math.min(lastHitEnd, limit)
    if (segEnd - from < 4) continue
    // OPEN only when the buffer boundary cut the segment mid-stream: the
    // segment consumed everything up to the buffer end AND the buffer ends
    // with an odd trailing byte — half a code unit awaiting its pair in the
    // next push. (lastHitEnd counts whole code units, so the odd byte is
    // invisible to it; the buffer's own odd length is the signal.)
    const ranOut = lastHitEnd >= limit - 1
    const oddTail = (limit - from) % 2 === 1
    const isOpen = ranOut && oddTail
    return { start: from, end: isOpen ? limit : segEnd, encoding, isOpen }
  }
  return undefined
}

/**
 * Extension scan for the sticky UTF-16 mode: find where the pattern breaks
 * starting at offset 0 of the current buffer (which continues an open segment).
 */
function utf16SegmentEnd(
  buffer: Buffer,
  encoding: 'utf-16le' | 'utf-16be',
  _from: number,
  _requireAnchor: boolean,
): { end: number; isOpen: boolean } {
  const nulParity = encoding === 'utf-16le' ? 1 : 0
  let end = 0
  const limit = buffer.length
  let misses = 0
  let lastHitEnd = 0
  let asciiRun = 0
  while (end + 1 < limit) {
    const b0 = buffer[end]
    const b1 = buffer[end + 1]
    const highByte = nulParity === 1 ? b1 : b0
    const lowByte = nulParity === 1 ? b0 : b1
    // Extension is trusting: any CJK-range high byte extends (片=0x7247,
    // 到=0x5230); plain-ASCII runs break the segment.
    const hit = highByte === 0 || isCjkHighByte(highByte)
    const asciiUnit = (b0 >= 0x20 && b0 <= 0x7e) && (b1 >= 0x20 && b1 <= 0x7e)
    // UTF-8 hard breaks: a lead byte (0xE4..0xE9) at the HIGH position, or
    // the three-byte signature (lead at LOW + continuation high + next-low
    // continuation) for misaligned UTF-8.
    const highIsLead = nulParity === 1
      ? (b1 >= 0xe4 && b1 <= 0xe9)
      : (b0 >= 0xe4 && b0 <= 0xe9)
    if (highIsLead) break
    if (end + 3 < limit) {
      const nextLow = nulParity === 1 ? buffer[end + 2] : buffer[end + 3]
      const curHighCont = (nulParity === 1 ? b1 : b0) >= 0x80 && (nulParity === 1 ? b1 : b0) <= 0xbf
      const lowIsLead = nulParity === 1
        ? (b0 >= 0xe4 && b0 <= 0xe9)
        : (b1 >= 0xe4 && b1 <= 0xe9)
      const continuation = (b: number): boolean => b >= 0x80 && b <= 0xbf
      if (lowIsLead && curHighCont && continuation(nextLow)) break
    }
    if (asciiUnit) {
      asciiRun++
      end += 2
      lastHitEnd = end
      // A run of 4+ printable-ASCII code units is plain ASCII text
      // (`STDERR: `), not UTF-16: roll the segment back to the run start.
      // Runs of 1-3 are tolerated — CJK code units whose bytes all happen
      // to be printable (个=0x4E2A, 片=0x7247) are common.
      if (asciiRun >= 4) {
        lastHitEnd = end - asciiRun * 2
        break
      }
      continue
    }
    asciiRun = 0
    if (hit) {
      misses = 0
      end += 2
      lastHitEnd = end
    } else {
      // Punctuation code units (e.g. ，。！) have high bytes outside the CJK
      // range; allow short runs of them inside the segment.
      misses++
      if (misses >= 4) break
      end += 2
    }
  }
  // The segment ends at the last hit; miss code units belong to the next
  // (normal) segment.
  let segEnd = Math.min(lastHitEnd, limit)
  // Sticky-continuation trust: a short buffer (up to 2 code units) that
  // follows an open UTF-16 segment is almost certainly its continuation —
  // its code units may be CJK characters whose high byte happens to fall in
  // the printable-ASCII range (e.g. 息 = 0x606F, high byte 0x60 = '`'), which
  // the asciiHigh guard would otherwise reject. Only a UTF-8 lead byte can
  // veto this.
  if (segEnd === 0 && limit >= 2 && limit <= 4) {
    let hasLead = false
    const nulParity = encoding === 'utf-16le' ? 1 : 0
    for (let i = 0; i + 1 < limit; i += 2) {
      const high = nulParity === 1 ? buffer[i + 1] : buffer[i]
      if (high >= 0xe4 && high <= 0xe9) hasLead = true
    }
    if (!hasLead) segEnd = limit
  }
  // Open iff the buffer boundary cut the segment mid-stream: ran out of
  // bytes AND the buffer ends with an odd trailing byte (half a code unit).
  const ranOut = segEnd >= limit - 1
  const oddTail = limit % 2 === 1
  const isOpen = ranOut && oddTail
  // Include the odd trailing byte so the caller can carry it as a pending tail.
  return { end: isOpen ? limit : segEnd, isOpen }
}
