/**
 * Encoding-aware local shell executor: registers as `ctx.shell` with an
 * implementation that captures raw stdout/stderr bytes itself (bypassing the
 * subprocess seam's lossy UTF-8 decoding) and re-decodes them with automatic
 * encoding detection.
 *
 * Why it must own the spawn: the core subprocess seam decodes every captured
 * stream through `Buffer.toString('utf8')` and exposes only the decoded text
 * (`SubprocessOutputReader.readFrom`), so any wrapper above it sees
 * unrecoverable mojibake — wsl.exe's UTF-16LE proxy warning becomes
 * `...hKm0R localhost ...`. Owning the spawn keeps the original bytes.
 *
 * Seam history: this executor originally replaced `ctx.bash`
 * (`@deepseek-ai/dsh-bash`, snapshots 0808-0812). The 0.1.0 npm line moved
 * the whole capability to the `ctx.shell` Service Definition
 * (`@deepseek-ai/dsh-shell`, `dsh-tool-bash` consumes `ctx.shell`), so the
 * executor now extends `ShellExecutor` — same raw-byte mechanics, new base.
 *
 * Scope notes (documented in README):
 * - No sandboxing: `sandboxMode` is undefined, like the vanilla local
 *   executor. Combine with a sandboxing wrapper if confinement is required.
 * - Ambient `DSH_*` entries and credential-named variables are scrubbed from
 *   the inherited environment, mirroring the subprocess seam's hygiene.
 * - Output is bounded by `maxOutputBytes` per stream; overflow truncates and
 *   flags `lossy` (no spill files — large outputs degrade to their tail).
 *
 * @module @dsh-external/dsh-bash-encoding
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type {
  ShellExecRequest,
  ShellExecSpec,
  ShellProcess,
  ShellProcessRead,
  ShellRunResult,
  CollectedOutput,
} from '@deepseek-ai/dsh-shell'
import { ChunkDecoder } from './decode-core.js'

/** Model-friendly terminal overrides, mirroring `dsh-bash-local`. */
const ENV_OVERRIDES = {
  NO_COLOR: '1',
  TERM: 'dumb',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/** Ambient variables whose names contain these markers are scrubbed. */
const CREDENTIAL_MARKERS = ['KEY', 'PASSWORD', 'SECRET', 'TOKEN']

/** Ambient `DSH_*` variables are scrubbed; managed facts arrive via `dshEnv`. */
const DSH_PREFIX = 'DSH_'

/**
 * A captured byte stream: raw chunks (for byte accounting and lossiness) plus
 * a chunk-level streaming decoder that reassembles interleaved encodings
 * (wsl.exe's UTF-16LE warning write, then the command's UTF-8 output).
 */
interface ByteStream {
  chunks: Buffer[]
  bytes: number
  capped: boolean
  /** Streaming decoder; decoded text accumulates incrementally. */
  decoder: ChunkDecoder
}

/** Plugin config (all optional — schemastery supplies the defaults). */
export interface EncodingBashConfig {
  /** Default working directory for commands (default: process.cwd()). */
  cwd?: string
  /** Default foreground timeout in milliseconds. */
  timeoutMs?: number
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs?: number
  /** Per-stream output cap in bytes; overflow truncates and flags `lossy`. */
  maxOutputBytes?: number
  /** Grace period for SIGTERM→SIGKILL escalation, in milliseconds. */
  graceMs?: number
}

/** The shape after schemastery applied the defaults (cwd has none). */
type ResolvedConfig = Required<Omit<EncodingBashConfig, 'cwd'>> & Pick<EncodingBashConfig, 'cwd'>

/** Scrub ambient environment like the subprocess seam: drop `DSH_*` and credential-named entries. */
function scrubAmbient(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith(DSH_PREFIX)) continue
    if (CREDENTIAL_MARKERS.some((marker) => key.toUpperCase().includes(marker))) continue
    clean[key] = value
  }
  return clean
}

/** Per-stream append with a byte cap: keep the head, drop the overflow, flag lossy, decode incrementally. */
function appendChunk(stream: ByteStream, chunk: Buffer, cap: number): void {
  const room = cap - stream.bytes
  if (room <= 0) {
    stream.capped = true
    return
  }
  const kept = chunk.length <= room ? chunk : chunk.subarray(0, room)
  stream.chunks.push(kept)
  stream.bytes += kept.length
  stream.decoder.push(kept)
  if (kept.length < chunk.length) stream.capped = true
}

/**
 * Encoding-aware local bash executor over `node:child_process`. One spawn per
 * `run`/`start`; the process group is owned and killed on timeout, abort, or
 * caller `kill()`. Registers as `ctx.shell` (one implementation per context,
 * cordis' standard duplicate-service rule).
 */
export class EncodingBashExecutor extends ShellExecutor {
  /** Validated config (schemastery filled defaults before construction). */
  readonly config: ResolvedConfig

  constructor(ctx: import('@deepseek-ai/cordis').Context, config: EncodingBashConfig) {
    super(ctx)
    this.config = config as ResolvedConfig
  }

  /** This executor does not confine; the vanilla local executor behaves the same. */
  override get sandboxMode(): undefined {
    return undefined
  }

  /**
   * Resolve a request into a fully-specified spec, capping overrides. The
   * caller's `sandboxPolicy`, when present, rides through untouched (this
   * executor never confines, like the vanilla `dsh-bash-local`).
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    const timeoutMs = Math.max(
      0,
      Math.min(request.timeoutMs ?? this.config.timeoutMs, this.config.maxTimeoutMs),
    )
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd ?? process.cwd(),
      timeoutMs,
      stdoutMaxBytes: request.stdoutMaxBytes ?? this.config.maxOutputBytes,
      ...request.signal !== undefined ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /** Spawn with raw-byte pipes and a scrubbed, overridden environment. */
  private spawnBash(spec: ShellExecSpec, argv: string[]): ChildProcess {
    const env = {
      ...scrubAmbient(process.env),
      ...ENV_OVERRIDES,
      ...spec.env,
      ...spec.dshEnv,
    }
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd: spec.workdir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own the process group so timeout/abort kills reach the whole tree.
      detached: process.platform !== 'win32',
    })
    if (spec.stdin !== undefined) {
      child.stdin?.end(spec.stdin)
    }
    return child
  }

  /** Kill the whole process tree: group signal on POSIX, taskkill on Windows. */
  private killTree(child: ChildProcess, signal: NodeJS.Signals): void {
    if (child.pid === undefined) return
    if (process.platform === 'win32') {
      // `taskkill /T` kills the tree; `child.kill()` alone would not.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }
    try {
      process.kill(-child.pid!, signal)
    } catch {
      try {
        child.kill(signal)
      } catch {
        // process already gone
      }
    }
  }

  /**
   * Drive one foreground spawn to completion: capture raw bytes, enforce the
   * fused timeout/abort deadline, and settle into a {@link ShellRunResult}.
   */
  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    const stdout: ByteStream = { chunks: [], bytes: 0, capped: false, decoder: new ChunkDecoder() }
    const stderr: ByteStream = { chunks: [], bytes: 0, capped: false, decoder: new ChunkDecoder() }
    const stdoutCap = spec.stdoutMaxBytes
    const stderrCap = this.config.maxOutputBytes

    let child: ChildProcess
    try {
      child = this.spawnBash(spec, ['bash', '-c', spec.command])
    } catch (error) {
      // Spawn failures settle as killed, with the error on stderr.
      return {
        exitCode: null,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: '', truncated: false },
        stderr: { text: `spawn failed: ${error instanceof Error ? error.message : String(error)}`, truncated: false },
      }
    }

    child.stdout?.on('data', (chunk: Buffer) => appendChunk(stdout, chunk, stdoutCap))
    child.stderr?.on('data', (chunk: Buffer) => appendChunk(stderr, chunk, stderrCap))

    // Spawn failures (ENOENT etc.) surface as an async 'error' event followed
    // by 'close' with code -2; per the seam contract they settle as killed
    // with the error text on stderr.
    let spawnError: string | undefined

    // Fused deadline: the executor's own timeout and the caller's abort race;
    // the first cause to fire wins the classification.
    let timedOut = false
    let aborted = false
    let settled = false
    const killOnDeadline = (): void => {
      if (settled) return
      this.killTree(child, 'SIGTERM')
      // Escalate after the grace period unless the process exited meanwhile.
      setTimeout(() => {
        if (!settled) this.killTree(child, 'SIGKILL')
      }, this.config.graceMs).unref()
    }
    const timer = setTimeout(() => {
      timedOut = true
      killOnDeadline()
    }, spec.timeoutMs)
    const onAbort = (): void => {
      aborted = true
      killOnDeadline()
    }
    spec.signal?.addEventListener('abort', onAbort, { once: true })

    const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('error', (error) => {
        spawnError = `spawn failed: ${error.message}`
      })
      child.on('close', (code, signal) => {
        settled = true
        resolve({ exitCode: spawnError !== undefined ? null : code, signal })
      })
    })
    clearTimeout(timer)
    spec.signal?.removeEventListener('abort', onAbort)

    const finalize = (stream: ByteStream): CollectedOutput => ({
      text: stream.decoder.text,
      truncated: stream.capped,
    })
    // A spawn failure carries no process output; the error text is the stderr.
    const stderrText = spawnError !== undefined
      ? `${spawnError}\n`
      : stderr.decoder.text
    return {
      ...outcome,
      timedOut,
      aborted,
      timeoutMs: spec.timeoutMs,
      stdout: finalize(stdout),
      stderr: { text: stderrText, truncated: stderr.capped },
    }
  }

  /** Start a background process; output stays buffered and readable after exit. */
  start(spec: ShellExecSpec): ShellProcess {
    const stdout: ByteStream = { chunks: [], bytes: 0, capped: false, decoder: new ChunkDecoder() }
    const stderr: ByteStream = { chunks: [], bytes: 0, capped: false, decoder: new ChunkDecoder() }
    const cap = this.config.maxOutputBytes

    let child: ChildProcess
    let spawnFailed: string | undefined
    try {
      child = this.spawnBash(spec, ['bash', '-c', spec.command])
    } catch (error) {
      // No process exists; settle immediately as killed with the error text.
      const note = `spawn failed: ${error instanceof Error ? error.message : String(error)}`
      const done = Promise.resolve()
      const proc: ShellProcess = {
        status: 'killed',
        exitCode: null,
        signal: null,
        done,
        readOutput: () => ({ delta: note, lossy: false }),
        kill: () => false,
      }
      return proc
    }

    child.stdout?.on('data', (chunk: Buffer) => appendChunk(stdout, chunk, cap))
    child.stderr?.on('data', (chunk: Buffer) => appendChunk(stderr, chunk, cap))

    let status: ShellProcess['status'] = 'running'
    let exitCode: number | null = null
    let signal: NodeJS.Signals | null = null
    let settled = false
    // Track decoded-text progress for incremental reads; full re-decode each
    // read keeps cross-chunk UTF-16 sequences consistent.
    let stdoutRead = 0
    let stderrRead = 0

    const done = new Promise<void>((resolve) => {
      child.on('close', (code, sig) => {
        settled = true
        status = 'completed'
        exitCode = code
        signal = sig
        resolve()
      })
      child.on('error', () => {
        // 'close' follows; nothing to do here beyond settling below.
      })
    })

    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done,
      readOutput: (): ShellProcessRead => {
        const out = stdout.decoder.text
        const err = stderr.decoder.text
        const deltaOut = out.slice(stdoutRead)
        const deltaErr = err.slice(stderrRead)
        stdoutRead = out.length
        stderrRead = err.length
        const separator = deltaOut.length > 0 && !deltaOut.endsWith('\n') ? '\n' : ''
        const delta = deltaOut + (deltaErr.length > 0 ? `${separator}[stderr]\n${deltaErr}` : '')
        return {
          delta,
          lossy: stdout.capped || stderr.capped,
        }
      },
      kill: (): boolean => {
        if (settled) return false
        status = 'killed'
        this.killTree(child, 'SIGKILL')
        return true
      },
    }
    // Live status fields on the handle mirror the settled facts as they arrive.
    Object.defineProperty(proc, 'status', { get: () => status, enumerable: true })
    Object.defineProperty(proc, 'exitCode', { get: () => exitCode, enumerable: true })
    Object.defineProperty(proc, 'signal', { get: () => signal, enumerable: true })
    return proc
  }
}
