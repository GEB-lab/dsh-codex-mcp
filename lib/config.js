/**
 * 插件配置归一化：把 cordis.patch.yml 里的 `config` 变成一份完整的运行期选项。
 *
 * 设计约束：
 * - 只允许绑定回环地址（默认 127.0.0.1）。想让局域网访问必须显式 allowNonLoopback: true，
 *   因为一旦绑到 0.0.0.0，本机就等于对外提供了"让 AI 改代码 + 执行命令"的能力。
 * - token 缺失时自动生成并写盘（0600），下次启动复用同一个 token，
 *   这样 Codex 的 config.toml 只需要写一次。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 39391
export const DEFAULT_PATH = '/mcp'
export const PLUGIN_NAME = 'dsh-codex-mcp'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** 把 `~/x`、`$DSH_HOME` 之类写法落成绝对路径，并相对 baseDir 解析相对路径。 */
export function expandPath(value, baseDir) {
  if (typeof value !== 'string' || value.length === 0) return value
  let text = value.trim()
  if (text === '~' || text.startsWith('~/') || text.startsWith('~\\')) text = join(homedir(), text.slice(1))
  if (!/^[a-zA-Z]:[\\/]/.test(text) && !text.startsWith('\\\\') && !text.startsWith('/')) text = resolve(baseDir, text)
  return text
}

/** 读取 token 文件；不存在或为空则生成新的 32 字节随机 token 并写盘。 */
export function loadOrCreateToken(tokenFile, { regenerate = false } = {}) {
  if (!regenerate && existsSync(tokenFile)) {
    const text = readFileSync(tokenFile, 'utf8').trim()
    if (text.length >= 16) return { token: text, created: false, tokenFile }
  }
  const token = randomBytes(32).toString('base64url')
  mkdirSync(dirname(tokenFile), { recursive: true })
  writeFileSync(tokenFile, `${token}\n`, { encoding: 'utf8', mode: 0o600 })
  return { token, created: true, tokenFile }
}

/**
 * 归一化插件配置。
 * @param {Record<string, unknown>} [raw] cordis.patch.yml 里该条目的 config
 * @param {NodeJS.ProcessEnv} [env] 宿主进程环境
 * @param {string} [cwd] 解析相对路径的基准目录（默认宿主 cwd）
 */
export function normalizeConfig(raw = {}, env = process.env, cwd = process.cwd()) {
  const config = raw ?? {}
  const baseDir = typeof config.baseDir === 'string' ? expandPath(config.baseDir, cwd) : cwd

  const host = String(config.host ?? DEFAULT_HOST)
  if (!LOOPBACK_HOSTS.has(host.toLowerCase()) && config.allowNonLoopback !== true) {
    throw new Error(
      `dsh-codex-mcp: refusing to bind ${JSON.stringify(host)} — 该插件能让调用方执行任意命令，只允许回环地址；`
      + '如确实需要局域网访问，请在 config 中显式设置 allowNonLoopback: true 并自行承担风险。',
    )
  }

  const port = Number(config.port ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`dsh-codex-mcp: invalid port ${JSON.stringify(config.port)}`)
  }

  const rawPath = String(config.path ?? DEFAULT_PATH)
  const mcpPath = rawPath.startsWith('/') ? rawPath : `/${rawPath}`

  const dshHome = expandPath(config.dshHome ?? env.DSH_HOME ?? join(homedir(), '.dsh'), baseDir)
  const tokenFile = expandPath(config.tokenFile ?? join(dshHome, 'codex-mcp.token'), baseDir)
  const { token, created } = loadOrCreateToken(tokenFile, { regenerate: config.regenerateToken === true })

  const defaultTimeoutSec = Number(config.defaultTimeoutSec ?? 3600)
  const maxConcurrentRuns = Number(config.maxConcurrentRuns ?? 4)

  return {
    pluginName: PLUGIN_NAME,
    host,
    port,
    path: mcpPath,
    token,
    tokenFile,
    tokenCreated: created,
    dshHome,
    profile: String(config.profile ?? 'headless'),
    permissionMode: String(config.permissionMode ?? 'danger-full-access'),
    defaultCwd: expandPath(config.defaultCwd ?? cwd, baseDir),
    defaultTimeoutSec: Number.isFinite(defaultTimeoutSec) && defaultTimeoutSec > 0 ? defaultTimeoutSec : 3600,
    maxConcurrentRuns: Number.isInteger(maxConcurrentRuns) && maxConcurrentRuns > 0 ? maxConcurrentRuns : 4,
    dshCli: config.dshCli ? expandPath(config.dshCli, baseDir) : undefined,
    nodePath: config.nodePath ? expandPath(config.nodePath, baseDir) : undefined,
    locale: String(config.locale ?? 'zh'),
    includeEvents: config.includeEvents === true,
    allowNonLoopback: config.allowNonLoopback === true,
  }
}
