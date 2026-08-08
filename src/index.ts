/**
 * `dsh-bash-encoding` plugin entry: registers the encoding-aware local bash
 * executor as `ctx.bash` (one implementation per context, cordis'
 * standard duplicate-service rule). Mount it INSTEAD OF
 * `@deepseek-ai/dsh-bash-local` in the profile's cordis.yml:
 *
 * ```yaml
 * - id: bash
 *   name: '@dsh-external/dsh-bash-encoding'
 *   config:
 *     timeoutMs: 120000
 * ```
 *
 * The tool layer (`@deepseek-ai/dsh-tool-bash`) injects `ctx.bash` and needs
 * no changes; this plugin only swaps the implementation behind the seam.
 *
 * @module @dsh-external/dsh-bash-encoding
 */

import z from 'schemastery'
import { EncodingBashExecutor } from './executor.js'

export { EncodingBashExecutor } from './executor.js'
export * from './decode-core.js'

/**
 * The encoding-aware bash executor with validated config. Schemastery fills
 * the defaults before construction; `cwd` has none (falls back to
 * `process.cwd()` at resolve time).
 */
export default class EncodingBashExecutorPlugin extends EncodingBashExecutor {
  static Config = z.object({
    cwd: z.string(),
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(64 * 1024),
    graceMs: z.number().default(3_000),
  })
}
