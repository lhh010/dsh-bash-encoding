# dsh-bash-encoding

DSH bash 输出**编码自动识别**插件：替换 `ctx.bash`，自管 spawn 收集**原始字节**，自动检测
UTF-16LE / UTF-8 / GBK 等编码并正确解码，修复 Windows/WSL 下 bash 工具的中文乱码。

## 使用环境（重点）

本插件解决的是 **Windows + WSL 组合下的中文乱码**，典型触发条件：

| 条件 | 说明 |
|---|---|
| 操作系统 | Windows（DSH 运行在 Windows 侧，bash 经 WSL 执行） |
| WSL 网络模式 | **NAT 模式**（`%UserProfile%\.wslconfig` 未设置 `networkingMode=mirrored`） |
| 代理配置 | 环境变量 `HTTP_PROXY` / `HTTPS_PROXY` 指向 `localhost` |

当以上条件同时满足时，**每次执行 bash 命令**，`wsl.exe` 启动器都会向 stderr 输出一条
**UTF-16LE 编码**的代理警告，而 DSH 核心以 UTF-8 有损解码 → 必现乱码（见下方对比 1）。

> 附带修复的场景：任何输出非 UTF-8 字节的程序（GBK 中文工具、UTF-16 输出等），
> 以及 UTF-16LE 警告与命令自身 UTF-8 输出**混合在同一管道**的情况（最棘手，见对比 2/3）。

## 问题根因

DSH 核心的 subprocess 层对所有输出执行 `Buffer.toString('utf8')` **有损解码**
（`readFrom()` 只暴露解码后的文本，原始字节在转换中丢失），于是 UTF-16LE 字节变成
不可恢复的乱码。任何包在 `ctx.subprocess` 之上的包装都无法修复——因为看到的已经是
乱码文本。本插件绕过该层：**自己 spawn 子进程、自己收集原始 Buffer、检测后解码**。

## 效果对比（前后）

### 对比 1：WSL 代理警告（最典型，每次命令必现）

```
❌ 修复前（DSH 核心 exec）:
w s l: �hKm0R localhost �NtM�nFO*g\��P0R WSL0NAT !j_N�v WSL \rN/e c localhost �Nt

✅ 修复后（本插件）:
wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。
```

### 对比 2：UTF-16LE 警告 + 命令自身 UTF-8 输出（同一 stderr 管道）

```
❌ 修复前:
wsl: 检测到 localhost 代理配置
釥戒护鑷: 涓枃鏄剧ず姝ｅ父 hello        ← 命令输出被当作 UTF-16 解

✅ 修复后:
wsl: 检测到 localhost 代理配置
命令自身输出: 中文显示正常 hello
```

### 对比 3：ASCII 前缀 + 中文（`STDERR: ...` 形态）

```
❌ 修复前:
STDERR: 呓䕄剒›命令自己的错误信息       ← ASCII 前缀被 UTF-16 吞并

✅ 修复后:
STDERR: 命令自己的错误信息
```

### 对比 4：GBK 输出（Windows 中文代码页工具）

```
❌ 修复前（核心 exec 按 UTF-8 解 GBK 字节）:  乱码
✅ 修复后:  GBK编码测试输出
```

### 对比 5：长 UTF-16 流跨管道 chunk（8KB 以上必现）

```
❌ 修复前:  这是一段非常长的UTF-16中文输úQ(uNKm...   ← 管道 chunk 边界处错位
✅ 修复后:  这是一段非常长的UTF-16中文输出用于测试跨chunk解码（完整）
```

## 测试场景表（全部通过，26/26）

| # | 场景 | 说明 | 结果 |
|---|---|---|---|
| 1 | WSL 代理警告（stderr，UTF-16LE） | 每次命令必现，最典型场景 | ✅ |
| 2 | 警告 + UTF-8 输出混合流（同管道） | wsl.exe 警告与命令输出合并进同一 buffer | ✅ |
| 3 | ASCII 前缀 + 中文（`STDERR: ...`） | 大写字母前缀不再被 UTF-16 吞并 | ✅ |
| 4 | GBK 输出 | Windows 中文代码页工具 | ✅ |
| 5 | 长 UTF-16 流跨管道 chunk | 8KB+ 含 ASCII 子串（`UTF-16`），1024B chunk 切割 | ✅ |
| 6 | 11 字节小 chunk 分片 | 纯中文 UTF-16 流被切成奇数长度小块 | ✅ |
| 7 | 后台任务混合编码 | run_in_background + UTF-16LE/UTF-8 混合 | ✅ |
| 8 | 多段写入混合流 | 警告 + 多次 UTF-8 写入 + 跨 chunk 中文 | ✅ |
| 9 | 纯 ASCII 输出 | `hello world` 不被误判 UTF-16 | ✅ |
| 10 | 纯 UTF-8 中文长输出 | 50 行中文无回归 | ✅ |
| 11 | 中英混排输出 | `hello world 你好世界` | ✅ |
| 12 | UTF-16 尾字节跨 chunk | 半个 code unit 正确配对 | ✅ |
| 13 | 单元测试 | 解码内核：BOM/NUL 启发式/严格 UTF-8/GBK/GB18030 | ✅ |
| 14 | 执行器端到端 | 真实 spawn：exit code/stdin/超时/后台/spawn 失败 | ✅ |

## 安装

```sh
# 在插件目录安装依赖（DSH 需要 Node ^22.19 || >=24）
cd /path/to/dsh-bash-encoding && pnpm install && pnpm build
```

将插件接入 DSH web profile（与 `dsh-shell-windows` 等外部插件同样的方式）：

```sh
cd "${DSH_HOME:-$HOME/.dsh}/profiles/web"
pnpm add -w link:/path/to/dsh-bash-encoding
```

## 配置

在 profile 的 `cordis.yml`（或 `cordis.patch.yml`）中**替换** bash 条目
（`@deepseek-ai/dsh-bash-local` 或 `@deepseek-ai/dsh-bash-sandbox` 二选一被本插件替代；
同一 context 只能有一个 `ctx.bash`）：

```yaml
# ... 原有其他条目不变 ...
- id: bash
  name: '@dsh-external/dsh-bash-encoding'
  config:
    cwd: null            # 默认工作目录（默认 process.cwd()）
    timeoutMs: 120000    # 前台命令默认超时
    maxTimeoutMs: 600000 # 单次超时上限
    maxOutputBytes: 65536  # 每流输出上限（超限截断并标记 lossy）
    graceMs: 3000        # SIGTERM→SIGKILL 宽限期
```

> **注意（patch 文件）**：patch 的 `name` 字段只做校验、不能替换插件。若通过
> `cordis.patch.yml` 接入，需先 `disabled: true` 停用原 bash 条目，再 `insert` 本插件。

重启 `dsh web` 后生效。bash 工具、后台任务、hooks 桥的所有输出都自动经过编码检测。

## 编码检测顺序

1. **纯 ASCII** 快速路径（无高字节 → UTF-8，避免 ASCII 字母误判 UTF-16）
2. **BOM**：UTF-8 (`EF BB BF`) / UTF-16LE (`FF FE`) / UTF-16BE (`FE FF`)
3. **UTF-16 段检测**（流式、chunk 内分段）：
   - NUL 奇偶位锚定（ASCII 子段，如 `wsl: `）
   - CJK 高字节优势锚定（纯中文段）
   - 段内信任延伸 + 连续 4 个可打印 ASCII code unit 回退断段（区分 `STDERR` 与 `个`/`片`）
   - UTF-8 三字节签名硬断（lead + 双续字节）
4. **严格 UTF-8 校验**（fatal decoder）通过 → UTF-8
5. **GBK**，再 **GB18030**（Windows 中文 OEM 代码页 936/54936 的兜底）
6. **Latin-1** 最后兜底（永不失败）

## 验证

```sh
pnpm test   # 26 个用例：解码内核 + 真实 spawn 端到端（UTF-16LE/GBK/混合流/超时/后台/失败路径）
```

## 范围与限制

| 面 | 状态 | 说明 |
|---|---|---|
| bash 工具输出（Web/TUI/hooks/后台） | ✅ 修复 | 替换 `ctx.bash` 后所有下游自动受益 |
| 沙箱兼容 | ✅ 支持 | 运行时探测 `ctx.sandbox`/`ctx.sandboxPolicy`，非 full-access 走 confine 路径，`sandboxMode` 惰性读取 |
| read 工具读 GBK/UTF-16 文件 | ⏳ 路线图 v2 | `FileSystem` 是抽象 seam；需包装 `readText` 且保留沙箱链 |
| node-pty 交互终端（tool-pty / dsh-web-terminal） | ❌ 不可修复 | node-pty 内部已按 UTF-8 有损解码，插件层拿不到原始字节 |
| subprocess 核心层 | ❌ 不改动 | 基础服务替换风险大，不做 |

其他说明：

- **环境净化**：继承环境中 `DSH_*` 前缀与名称含 `KEY/PASSWORD/SECRET/TOKEN` 的变量会被
  清除（对齐 subprocess seam 的 hygiene），托管变量经 `dshEnv` 显式传入。
- **大输出**：超过 `maxOutputBytes` 保留头部并标记 `lossy`（不做 spill 文件）。
- **治本建议**（可选，与插件互补）：将 `.wslconfig` 的 `networkingMode` 改为 `mirrored`，
  或设置 `WSL_UTF8=1`，可从源头消除 WSL 警告本身的输出。

## 结构

```
src/decode-core.ts   # 编码检测内核（ChunkDecoder 流式分段解码）：纯函数、零依赖、可独立测试
src/executor.ts      # EncodingBashExecutor：自管 spawn + 原始字节 + 检测解码 + 沙箱
src/index.ts         # 插件入口（schemastery Config）
tests/               # node:test 单元 + 端到端
```

## 许可

BSD-3-Clause
