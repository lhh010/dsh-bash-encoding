# dsh-bash-encoding

DSH bash 输出**编码自动识别**插件：替换 `ctx.bash`，自管 spawn 收集**原始字节**，自动检测
UTF-16LE / UTF-8 / GBK 等编码并正确解码，修复 Windows/WSL 下 bash 工具的中文乱码。

## 问题

在 Windows + WSL 环境下，`wsl.exe` 启动器会向 stderr 输出 UTF-16LE 编码的代理警告：

```
wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。推荐镜像模式。
```

DSH 核心的 subprocess 层对所有输出执行 `Buffer.toString('utf8')` **有损解码**（`readFrom()`
只暴露解码后的文本，原始字节在转换中丢失），于是 UTF-16LE 字节变成不可恢复的乱码：

```
w s l: �hKm0R localhost �NtM�nFO*g\��P0R WSL0NAT !j_N�v WSL ...
```

任何包在 `ctx.subprocess` 之上的包装都无法修复——因为看到的已经是乱码文本。
本插件绕过该层：**自己 spawn 子进程、自己收集原始 Buffer、检测后解码**。

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

在 profile 的 `cordis.yml` 中**替换** bash 条目（`@deepseek-ai/dsh-bash-local` 或
`@deepseek-ai/dsh-bash-sandbox` 二选一被本插件替代；同一 context 只能有一个 `ctx.bash`）：

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

重启 `dsh web` 后生效。bash 工具、后台任务、hooks 桥的所有输出都自动经过编码检测。

## 编码检测顺序

1. **BOM**：UTF-8 (`EF BB BF`) / UTF-16LE (`FF FE`) / UTF-16BE (`FE FF`)
2. **UTF-16 启发式**：NUL 字节奇偶位分布（ASCII 混合流）+ CJK 高字节分布（纯中文流）
3. **严格 UTF-8 校验**（fatal decoder）通过 → UTF-8
4. **GBK**，再 **GB18030**（Windows 中文 OEM 代码页 936/54936 的兜底）
5. **Latin-1** 最后兜底（永不失败）

## 验证

```sh
pnpm test   # 20 个用例：解码内核 + 真实 spawn 端到端（UTF-16LE/GBK/超时/后台/失败路径）
```

并排对比（同一命令）：

```
核心 exec:  w s l: �hKm0R localhost �NtM�nFO*g\��P0R WSL0NAT !j_N�v WSL ...
本插件:    wsl: 检测到 localhost 代理配置，但未镜像到 WSL。NAT 模式下的 WSL 不支持 localhost 代理。推荐镜像模式。
```

## 范围与限制

| 面 | 状态 | 说明 |
|---|---|---|
| bash 工具输出（Web/TUI/hooks/后台） | ✅ 修复 | 替换 `ctx.bash` 后所有下游自动受益 |
| read 工具读 GBK/UTF-16 文件 | ⏳ 路线图 v2 | `FileSystem` 是抽象 seam；需包装 `readText` 且保留沙箱链 |
| node-pty 交互终端（tool-pty / dsh-web-terminal） | ❌ 不可修复 | node-pty 内部已按 UTF-8 有损解码，插件层拿不到原始字节 |
| subprocess 核心层 | ❌ 不改动 | 基础服务替换风险大，不做 |

其他说明：

- **不提供沙箱**：`sandboxMode` 为 `undefined`（与 `dsh-bash-local` 一致）。需要沙箱时请自行组合
  或等待 v2 的沙箱包装。
- **环境净化**：继承环境中 `DSH_*` 前缀与名称含 `KEY/PASSWORD/SECRET/TOKEN` 的变量会被
  清除（对齐 subprocess seam 的 hygiene），托管变量经 `dshEnv` 显式传入。
- **大输出**：超过 `maxOutputBytes` 保留头部并标记 `lossy`（不做 spill 文件）。

## 结构

```
src/decode-core.ts   # 编码检测内核：纯函数、零依赖、可独立测试
src/executor.ts      # EncodingBashExecutor：自管 spawn + 原始字节 + 检测解码
src/index.ts         # 插件入口（schemastery Config）
tests/               # node:test 单元 + 端到端
```

## 许可

BSD-3-Clause
