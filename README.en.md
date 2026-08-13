# dsh-bash-encoding

[简体中文](./README.md) | **English**

DSH bash output **encoding auto-detection** plugin: replaces `ctx.bash`, manages its own spawn to collect **raw bytes**, auto-detects encodings such as UTF-16LE / UTF-8 / GBK and decodes them correctly, fixing garbled Chinese output from the bash tool on Windows/WSL.

## 版本兼容 / Version compatibility

Compatible with DSH snapshot0808 (`snapshots/20260808T121140Z`) and snapshot0809 (`snapshots/20260809T140917Z`): a host-side plugin that replaces the `ctx.bash` executor, depending only on the bash seam and the `ctx.sandbox`/`ctx.sandboxPolicy` probing surface — none of which changed in 0808/0809; typecheck and real-machine loading have been verified.

**npm release compatibility**: compatible with the DSH npm release `@deepseek-ai/dsh@0.0.1-rc.1` (the npm release of snapshot0810; `npx -p @deepseek-ai/dsh@0.0.1-rc.1 dsh web` can access and launch that version, lib production mode). Verified (same-source local baseline): runtime loading passes after installing the npm baseline, and 25 of 26 unit tests pass (the only failure is environmental noise from the local WSL localhost proxy warning mixing into stderr on this machine; the decoding behavior itself is correct). Note: `peerDependencies.cordis` is declared as `^4.0.0-rc.7`, while the npm release publishes the vendored `cordis` together under the unified prerelease version `0.0.1-rc.?` — for a plain `npm install`, if a peer conflict (ERESOLVE) is reported, add `--legacy-peer-deps`; installation via `dsh plugin`/pnpm handles this automatically and runtime is unaffected.

### 0809 compatibility notes (verified on a real machine)

- Under a running `dsh web` on 0809, this plugin correctly replaces `ctx.bash` (the wiring method of disabling `bash-sandbox` via patch + inserting this plugin is unchanged): the WSL UTF-16LE proxy warning in stderr of every bash call is correctly decoded into Chinese, with no mojibake — the core fix path is verified to work.
- 0809 keeps the bash seam (service name `ctx.bash` and the `BashExecutor` inheritance surface) and the `ctx.sandbox`/`ctx.sandboxPolicy` probing surface, so the plugin needs no changes and can reuse the existing `lib/` build.
- This plugin has no client bundle, so it is unaffected by the 0809 client plugin mechanism (`dshClient` declaration / `ClientPackageCompositionError` startup validation).

## Windows native profile disablement notes

Under the **Windows native (no WSL) profile**, this plugin is **disabled by default** (commented-out section in `cordis.patch.yml`), because:

- The platform layer `windows.cordis.patch.yml` already inserts `pwsh-sandbox` (`SandboxPwshExecutor`), which — like this plugin — registers `ctx.bash`; only one `ctx.bash` implementation is allowed per context, and enabling both at once causes startup failure (`service bash has been registered at <EncodingBashExecutorPlugin>`).
- This plugin spawns via `bash -c` and targets the POSIX bash stack (replacing `dsh-bash-local`); the Windows native profile uses the pwsh stack with no bash runner, so it is not applicable there anyway.

When needed (POSIX/WSL profile, or explicit replacement of `dsh-bash-local`), wire it in per the "Installation" section below — this is a profile-configuration-level disablement decision, not a code deprecation.

## Usage environment (important)

This plugin fixes **garbled Chinese under the Windows + WSL combination**. The typical triggering conditions:

| Condition | Description |
|---|---|
| OS | Windows (DSH runs on the Windows side; bash runs via WSL) |
| WSL networking mode | **NAT mode** (`%UserProfile%\.wslconfig` does not set `networkingMode=mirrored`) |
| Proxy configuration | Environment variables `HTTP_PROXY` / `HTTPS_PROXY` point to `localhost` |

When all of the above conditions hold, **on every bash command execution** the `wsl.exe` launcher writes a **UTF-16LE-encoded** proxy warning to stderr, and the DSH core decodes it lossily as UTF-8 → mojibake is guaranteed (see comparison 1 below).

> Scenarios fixed as a bonus: any program emitting non-UTF-8 bytes (GBK Chinese tools, UTF-16 output, etc.), and the case where the UTF-16LE warning and the command's own UTF-8 output are **mixed in the same pipe** (the trickiest case, see comparisons 2/3).

## Root cause

The DSH core's subprocess layer performs a **lossy** `Buffer.toString('utf8')` decode on all output (`readFrom()` exposes only the decoded text; the raw bytes are lost in the conversion), so UTF-16LE bytes become unrecoverable mojibake. Any wrapper built on `ctx.subprocess` cannot fix this — because what it sees is already mojibake text. This plugin bypasses that layer: **it spawns the child process itself, collects raw Buffers itself, and decodes after detection**.

## Before/after comparison

### Comparison 1: WSL proxy warning (most typical, appears on every command)

```
❌ Before (DSH core exec):
w s l: �hKm0R localhost �NtM�nFO*g\��P0R WSL0NAT !j_N�v WSL \rN/e c localhost �Nt

✅ After (this plugin):
wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。
```

### Comparison 2: UTF-16LE warning + the command's own UTF-8 output (same stderr pipe)

```
❌ Before:
wsl: 检测到 localhost 代理配置
釥戒护鑷: 涓枃鏄剧ず姝ｅ父 hello        ← command output decoded as UTF-16

✅ After:
wsl: 检测到 localhost 代理配置
命令自身输出: 中文显示正常 hello
```

### Comparison 3: ASCII prefix + Chinese (`STDERR: ...` form)

```
❌ Before:
STDERR: 呓䕄剒›命令自己的错误信息       ← ASCII prefix swallowed by UTF-16

✅ After:
STDERR: 命令自己的错误信息
```

### Comparison 4: GBK output (Windows Chinese code-page tool)

```
❌ Before (core exec decodes GBK bytes as UTF-8):  mojibake
✅ After:  GBK编码测试输出
```

### Comparison 5: Long UTF-16 stream across pipe chunks (guaranteed above 8KB)

```
❌ Before:  这是一段非常长的UTF-16中文输úQ(uNKm...   ← misaligned at pipe chunk boundary
✅ After:  这是一段非常长的UTF-16中文输出用于测试跨chunk解码（完整）
```

## Test scenario table (all pass, 26/26)

| # | Scenario | Description | Result |
|---|---|---|---|
| 1 | WSL proxy warning (stderr, UTF-16LE) | Appears on every command; the most typical scenario | ✅ |
| 2 | Warning + UTF-8 output mixed stream (same pipe) | wsl.exe warning and command output merged into the same buffer | ✅ |
| 3 | ASCII prefix + Chinese (`STDERR: ...`) | Uppercase-letter prefix no longer swallowed by UTF-16 | ✅ |
| 4 | GBK output | Windows Chinese code-page tool | ✅ |
| 5 | Long UTF-16 stream across pipe chunks | 8KB+ containing an ASCII substring (`UTF-16`), cut into 1024B chunks | ✅ |
| 6 | 11-byte small-chunk fragmentation | Pure-Chinese UTF-16 stream split into odd-length small pieces | ✅ |
| 7 | Background task with mixed encodings | run_in_background + UTF-16LE/UTF-8 mixed | ✅ |
| 8 | Multi-segment write mixed stream | Warning + multiple UTF-8 writes + Chinese across chunks | ✅ |
| 9 | Pure ASCII output | `hello world` not misdetected as UTF-16 | ✅ |
| 10 | Long pure-UTF-8 Chinese output | 50 lines of Chinese with no regression | ✅ |
| 11 | Mixed Chinese/English output | `hello world 你好世界` | ✅ |
| 12 | UTF-16 trailing byte across chunks | Half a code unit correctly paired | ✅ |
| 13 | Unit tests | Decode core: BOM/NUL heuristic/strict UTF-8/GBK/GB18030 | ✅ |
| 14 | Executor end-to-end | Real spawn: exit code/stdin/timeout/background/spawn failure | ✅ |

## Installation

```sh
# Install dependencies in the plugin directory (DSH requires Node ^22.19 || >=24)
cd /path/to/dsh-bash-encoding && pnpm install && pnpm build
```

Wire the plugin into the DSH web profile (the same way as external plugins such as `dsh-shell-windows`):

```sh
cd "${DSH_HOME:-$HOME/.dsh}/profiles/web"
pnpm add -w link:/path/to/dsh-bash-encoding
```

## Configuration

**Replace** the bash entry in the profile's `cordis.yml` (or `cordis.patch.yml`) (either `@deepseek-ai/dsh-bash-local` or `@deepseek-ai/dsh-bash-sandbox` is replaced by this plugin; only one `ctx.bash` may exist per context):

```yaml
# ... other existing entries unchanged ...
- id: bash
  name: '@dsh-external/dsh-bash-encoding'
  config:
    cwd: null            # default working directory (defaults to process.cwd())
    timeoutMs: 120000    # default timeout for foreground commands
    maxTimeoutMs: 600000 # per-command timeout cap
    maxOutputBytes: 65536  # per-stream output cap (truncated and marked lossy when exceeded)
    graceMs: 3000        # SIGTERM→SIGKILL grace period
```

> **Note (patch files)**: a patch's `name` field is only validated and cannot replace a plugin. If wiring in via `cordis.patch.yml`, first disable the original bash entry with `disabled: true`, then `insert` this plugin.

Restart `dsh web` for the change to take effect. All output from the bash tool, background tasks, and the hooks bridge automatically goes through encoding detection.

## Encoding detection order

1. **Pure ASCII** fast path (no high bytes → UTF-8, avoids ASCII letters being misdetected as UTF-16)
2. **BOM**: UTF-8 (`EF BB BF`) / UTF-16LE (`FF FE`) / UTF-16BE (`FE FF`)
3. **UTF-16 segment detection** (streaming, segment-wise within chunks):
   - NUL odd/even anchoring (ASCII sub-segments, e.g. `wsl: `)
   - CJK high-byte-dominance anchoring (pure-Chinese segments)
   - In-segment trust extension + break on 4 consecutive printable ASCII code units (distinguishes `STDERR` from `个`/`片`)
   - UTF-8 three-byte signature hard break (lead + two continuation bytes)
4. **Strict UTF-8 validation** (fatal decoder) passes → UTF-8
5. **GBK**, then **GB18030** (fallback for Windows Chinese OEM code pages 936/54936)
6. **Latin-1** as the final fallback (never fails)

## Verification

```sh
pnpm test   # 26 test cases: decode core + real-spawn end-to-end (UTF-16LE/GBK/mixed streams/timeout/background/failure paths)
```

## Scope and limitations

| Surface | Status | Description |
|---|---|---|
| bash tool output (Web/TUI/hooks/background) | ✅ Fixed | All downstream consumers automatically benefit after replacing `ctx.bash` |
| Sandbox compatibility | ✅ Supported | Probes `ctx.sandbox`/`ctx.sandboxPolicy` at runtime; non-full-access takes the confine path; `sandboxMode` read lazily |
| read tool reading GBK/UTF-16 files | ⏳ Roadmap v2 | `FileSystem` is an abstract seam; requires wrapping `readText` while preserving the sandbox chain |
| node-pty interactive terminals (tool-pty / dsh-web-terminal) | ❌ Not fixable | node-pty already decodes lossily as UTF-8 internally; the plugin layer cannot obtain raw bytes |
| subprocess core layer | ❌ Not modified | Replacing the base service is too risky; not done |

Additional notes:

- **Environment sanitization**: variables with the `DSH_` prefix and names containing `KEY/PASSWORD/SECRET/TOKEN` in the inherited environment are cleared (aligned with the subprocess seam's hygiene); managed variables are passed in explicitly via `dshEnv`.
- **Large output**: when `maxOutputBytes` is exceeded, the head is kept and marked `lossy` (no spill files).
- **Root-cause suggestion** (optional, complementary to the plugin): set `networkingMode` to `mirrored` in `.wslconfig`, or set `WSL_UTF8=1`, to eliminate the WSL warning output at its source.

## Structure

```
src/decode-core.ts   # encoding detection core (ChunkDecoder streaming segment-wise decode): pure functions, zero dependencies, independently testable
src/executor.ts      # EncodingBashExecutor: self-managed spawn + raw bytes + detect-and-decode + sandbox
src/index.ts         # plugin entry (schemastery Config)
tests/               # node:test unit + end-to-end
```

## License

BSD-3-Clause
