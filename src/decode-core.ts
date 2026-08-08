/**
 * Encoding detection and decoding core for `dsh-bash-encoding`.
 *
 * Zero-dependency, pure functions over raw bytes. The bash subprocess seam
 * decodes every stream as UTF-8 (`Buffer.toString('utf8')`), which turns
 * UTF-16LE output — e.g. wsl.exe's localhost-proxy warning on Windows — into
 * unrecoverable mojibake (`�hKm0R …`). This module re-decodes the raw bytes
 * this plugin captures itself, before any lossy conversion happens.
 *
 * Detection order:
 * 1. BOM (UTF-8 / UTF-16LE / UTF-16BE).
 * 2. NUL-byte parity heuristic for BOM-less UTF-16.
 * 3. Strict UTF-8 validation (fatal decoder).
 * 4. GBK, then GB18030, as the CJK legacy fallback (Windows OEM codepages
 *    936/54936 for Chinese tools).
 * 5. Latin-1 as the last resort (never fails; better than mojibake).
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
  const limit = Math.min(buffer.length, 256)
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
 */
function detectUtf16ByCjkHighBytes(buffer: Buffer): 'utf-16le' | 'utf-16be' | null {
  if (buffer.length < 8) return null
  const limit = Math.min(buffer.length, 256)
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
  // A clear majority of code units carrying a CJK high byte on one side
  // (and not on the other) is a strong UTF-16 signature; GBK lead bytes
  // (0xB0..0xF7) and UTF-8 lead bytes (0xE4..0xE9) both fall outside it.
  if (oddRatio >= 0.6 && evenRatio <= 0.2) return 'utf-16le'
  if (evenRatio >= 0.6 && oddRatio <= 0.2) return 'utf-16be'
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
 * Detect the encoding of a raw byte stream.
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

/**
 * Decode a raw byte stream with automatic encoding detection.
 * @param buffer - raw captured bytes.
 * @returns the decoded text and the encoding that produced it.
 */
export function decodeBuffer(buffer: Buffer): DecodeResult {
  const encoding = detectEncoding(buffer)
  if (encoding === 'utf-8') {
    // Strip a BOM if present; TextDecoder keeps it in the output.
    const body = buffer.length >= 3 && buffer[0] === UTF8_BOM[0] && buffer[1] === UTF8_BOM[1] && buffer[2] === UTF8_BOM[2]
      ? buffer.subarray(3)
      : buffer
    return { text: new TextDecoder('utf-8').decode(body), encoding }
  }
  if (encoding === 'utf-16le' || encoding === 'utf-16be') {
    const bom = buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))
    let body = bom ? buffer.subarray(2) : buffer
    // A trailing odd byte is half a code unit (e.g. a lone `\n` appended after
    // a UTF-16 stream); drop it instead of emitting U+FFFD.
    if (body.length % 2 !== 0) body = body.subarray(0, body.length - 1)
    return { text: new TextDecoder(encoding).decode(body), encoding }
  }
  if (encoding === 'gbk' || encoding === 'gb18030') {
    const text = tryLegacyDecode(buffer, encoding)
    if (text !== null) return { text, encoding }
  }
  return { text: buffer.toString('latin1'), encoding: 'latin1' }
}
