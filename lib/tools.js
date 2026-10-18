/**
 * MCP 工具定义与执行逻辑：只暴露三个工具，职责单一。
 *   dsh_env    — 环境自检（版本、路径、token、是否可写、当前并发）
 *   dsh_run    — 新开会话跑一个任务
 *   dsh_resume — 在既有会话上续跑（同一段对话、同一 cwd）
 */
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { runHeadless } from './runner.js'

const MAX_TIMEOUT_SEC = 24 * 3600

/** 把 cwd 参数落成存在的绝对目录；不合法时抛错（由调用方转成 isError 结果）。 */
export function resolveTaskCwd(input, fallback) {
  const raw = typeof input === 'string' && input.trim().length > 0 ? input.trim() : fallback
  const absolute = isAbsolute(raw) ? raw : resolve(fallback, raw)
  if (!existsSync(absolute)) throw new Error(`cwd does not exist: ${absolute}`)
  if (!statSync(absolute).isDirectory()) throw new Error(`cwd is not a directory: ${absolute}`)
  return absolute
}

/** 解析超时秒数。 */
export function resolveTimeoutSec(input, fallback) {
  if (input === undefined || input === null || input === '') return fallback
  const value = Number(input)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`timeout_sec must be a positive number, got ${JSON.stringify(input)}`)
  return Math.min(value, MAX_TIMEOUT_SEC)
}

function formatUsage(usage) {
  if (!usage || Object.keys(usage).length === 0) return 'usage: unavailable'
  const parts = []
  if (usage.inputTokens !== undefined) parts.push(`in ${usage.inputTokens}`)
  if (usage.outputTokens !== undefined) parts.push(`out ${usage.outputTokens}`)
  if (usage.cacheReadTokens !== undefined) parts.push(`cacheRead ${usage.cacheReadTokens}`)
  if (usage.totalTokens !== undefined) parts.push(`total ${usage.totalTokens}`)
  return parts.length === 0 ? 'usage: unavailable' : `usage: ${parts.join(' / ')}`
}

function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`
}

/** 成功结果文本：状态行 + 关键字段 + 原样最终答案 + 续跑提示。 */
export function formatSuccess(result, { sessionRequested }) {
  const lines = []
  lines.push(`[DSH 完成] turn ${result.turns || 1} · steps ${result.steps} · ${formatSeconds(result.durationMs)}`)
  lines.push(`session: ${result.sessionId ?? '(unknown)'}`)
  lines.push(`cwd: ${result.cwd}`)
  lines.push(`exit: ${result.exitCode} · turn_end: ${result.turnEnd ?? '(none)'}`)
  lines.push(formatUsage(result.usage))
  lines.push('')
  lines.push('--- 最终答案 ---')
  lines.push(result.finalText)
  lines.push('')
  lines.push('--- 续跑同一会话 ---')
  lines.push(`dsh_resume({ "session_id": "${result.sessionId ?? ''}", "task": "<下一个任务>" })`)
  if (sessionRequested !== undefined && sessionRequested !== result.sessionId) {
    lines.push(`注意：请求续跑的会话是 ${sessionRequested}，实际返回 ${result.sessionId ?? '(unknown)'}。`)
  }
  return lines.join('\n')
}

/** 失败结果文本：把判定失败的原因、退出码、stderr 尾部、事件统计都摊开，便于排障。 */
export function formatFailure(reason, result, extra = {}) {
  const lines = []
  lines.push(`[DSH 失败] ${reason}`)
  if (result !== undefined) {
    lines.push(`session: ${result.sessionId ?? '(unknown)'}`)
    lines.push(`cwd: ${result.cwd}`)
    lines.push(`exit: ${result.exitCode ?? '(null)'} · turn_end: ${result.turnEnd ?? '(none)'} · ${formatSeconds(result.durationMs)}`)
    lines.push(formatUsage(result.usage))
    if (result.timedOut) lines.push(`已超时并按进程树强杀（taskkill /T /F）`)
    if (result.finalText && result.finalText.trim().length > 0) {
      lines.push('')
      lines.push('--- 已产出的最终答案（不完整） ---')
      lines.push(result.finalText)
    }
    const stderr = (result.stderrTail ?? '').trim()
    if (stderr.length > 0) {
      lines.push('')
      lines.push('--- stderr 尾部 ---')
      lines.push(stderr.slice(-4000))
    }
    const counts = result.eventCounts ?? {}
    if (Object.keys(counts).length > 0) {
      lines.push('')
      lines.push(`--- 事件统计 --- ${Object.entries(counts).map(([key, value]) => `${key}×${value}`).join(', ')}`)
    }
    if (result.malformed > 0) lines.push(`无法解析的事件行: ${result.malformed}`)
  }
  if (extra.hint) {
    lines.push('')
    lines.push(`提示：${extra.hint}`)
  }
  return lines.join('\n')
}

/** 判定一次运行是否算成功；返回失败原因，或 undefined。顺序刻意从"最确定的失败"到"最细的失败"。 */
export function classifyRun(result) {
  if (result.timedOut) return '超时：DSH 子进程没有在 timeout_sec 内结束'
  if (result.exitCode !== 0) {
    const stderr = (result.stderrTail ?? '').split('\n').map((line) => line.trim()).filter(Boolean).pop()
    return stderr ? `退出码 ${result.exitCode}：${stderr}` : `退出码 ${result.exitCode}`
  }
  if (result.turnEnd !== 'completed') return `turn_end 不是 completed（实际：${result.turnEnd ?? 'missing'}）`
  if (!result.finalSeen) return '事件流里没有 final 事件（DSH 可能中途失败）'
  if (typeof result.finalText !== 'string' || result.finalText.trim().length === 0) return '最终答案为空'
  return undefined
}

/**
 * 创建工具集合。
 * @param {object} deps
 * @param {object} deps.options 归一化后的插件配置
 * @param {object} deps.runtime 运行期信息（dshCli / dshVersion / node / running / startedAt / pluginVersion）
 * @param {object} deps.strings 本地化文案
 * @param {NodeJS.ProcessEnv} [deps.env] 宿主环境
 * @param {(level: string, message: string) => void} [deps.log]
 */
export function createTools({ options, runtime, strings, env = process.env, log = () => {} }) {
  const t = strings.tools

  const definitions = [
    {
      name: 'dsh_env',
      title: t.dsh_env.title,
      description: t.dsh_env.description,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { title: t.dsh_env.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'dsh_run',
      title: t.dsh_run.title,
      description: t.dsh_run.description,
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: t.dsh_run.task, minLength: 1 },
          cwd: { type: 'string', description: t.dsh_run.cwd },
          timeout_sec: { type: 'number', description: t.dsh_run.timeout_sec, minimum: 1, maximum: MAX_TIMEOUT_SEC },
          include_events: { type: 'boolean', description: t.common.include_events },
        },
        required: ['task'],
        additionalProperties: false,
      },
      annotations: { title: t.dsh_run.title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    {
      name: 'dsh_resume',
      title: t.dsh_resume.title,
      description: t.dsh_resume.description,
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: t.dsh_resume.session_id, minLength: 1 },
          task: { type: 'string', description: t.dsh_run.task, minLength: 1 },
          cwd: { type: 'string', description: t.dsh_run.cwd },
          timeout_sec: { type: 'number', description: t.dsh_run.timeout_sec, minimum: 1, maximum: MAX_TIMEOUT_SEC },
          include_events: { type: 'boolean', description: t.common.include_events },
        },
        required: ['session_id', 'task'],
        additionalProperties: false,
      },
      annotations: { title: t.dsh_resume.title, readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
  ]

  const errorResult = (text) => ({ content: [{ type: 'text', text }], isError: true })
  const textResult = (text) => ({ content: [{ type: 'text', text }], isError: false })

  function envInfo() {
    let homeWritable = false
    try {
      const target = resolve(options.dshHome)
      homeWritable = existsSync(target) ? statSync(target).isDirectory() : false
    } catch {
      homeWritable = false
    }
    return {
      plugin: {
        name: options.pluginName,
        version: runtime.pluginVersion,
        locale: options.locale,
        pid: process.pid,
        startedAt: runtime.startedAt,
      },
      mcp: {
        url: `http://${options.host}:${runtime.port}${options.path}`,
        host: options.host,
        port: runtime.port,
        path: options.path,
        token: options.token,
        tokenFile: options.tokenFile,
        tokenGenerated: options.tokenCreated,
      },
      dsh: {
        cli: runtime.dshCli,
        version: runtime.dshVersion,
        profile: options.profile,
        dshHome: options.dshHome,
        dshHomeExists: homeWritable,
        permissionMode: options.permissionMode,
        node: runtime.node.command,
        nodeKind: runtime.node.kind,
        nodeVersion: process.versions.node,
      },
      defaults: {
        cwd: options.defaultCwd,
        timeoutSec: options.defaultTimeoutSec,
        maxConcurrentRuns: options.maxConcurrentRuns,
      },
      runtime: {
        activeRuns: runtime.running.size,
        platform: process.platform,
      },
      codexConfig: [
        '[mcp_servers.dsh_codex]',
        `url = "http://${options.host}:${runtime.port}${options.path}"`,
        `http_headers = { Authorization = "Bearer ${options.token}" }`,
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 3600',
        'enabled = true',
      ].join('\n'),
    }
  }

  async function executeRun(args, { resume }) {
    const task = args?.task
    if (typeof task !== 'string' || task.trim().length === 0) return errorResult('参数错误：task 必须是非空字符串')
    let sessionId
    if (resume) {
      sessionId = args?.session_id
      if (typeof sessionId !== 'string' || sessionId.trim().length === 0) return errorResult('参数错误：session_id 必须是非空字符串（由上一次 dsh_run 返回）')
      sessionId = sessionId.trim()
    }
    if (runtime.running.size >= options.maxConcurrentRuns) {
      return errorResult(`并发上限：已有 ${runtime.running.size} 个 DSH 任务在跑（maxConcurrentRuns=${options.maxConcurrentRuns}）。等其中一个结束再派新任务。`)
    }
    let cwd
    let timeoutSec
    try {
      cwd = resolveTaskCwd(args?.cwd, options.defaultCwd)
      timeoutSec = resolveTimeoutSec(args?.timeout_sec, options.defaultTimeoutSec)
    } catch (cause) {
      return errorResult(`参数错误：${cause.message}`)
    }

    const envForChild = buildEnv()
    log('info', `${resume ? 'resume' : 'run'} start cwd=${cwd} timeout=${timeoutSec}s session=${sessionId ?? '(new)'}`)
    const controller = new AbortController()
    try {
      const result = await runHeadless({
        task,
        sessionId,
        cwd,
        timeoutSec,
        cliPath: runtime.dshCli,
        profile: options.profile,
        node: { command: runtime.node.command },
        env: envForChild,
        signal: controller.signal,
        onSpawn: (child) => {
          runtime.running.add(child.pid)
          child.once('close', () => runtime.running.delete(child.pid))
        },
      })
      const failure = classifyRun(result)
      const includeEvents = args?.include_events === true || options.includeEvents === true
      const eventsBlock = includeEvents && result.events.length > 0
        ? `\n\n--- 事件流（NDJSON，${result.events.length} 条）---\n${result.events.slice(-200).map((event) => JSON.stringify(event)).join('\n')}`
        : ''
      if (failure !== undefined) {
        log('warn', `${resume ? 'resume' : 'run'} failed: ${failure}`)
        return errorResult(formatFailure(failure, result, {
          hint: normalizeHint(result, options),
        }) + eventsBlock)
      }
      log('info', `${resume ? 'resume' : 'run'} ok session=${result.sessionId} steps=${result.steps} ${Math.round(result.durationMs / 1000)}s`)
      return textResult(formatSuccess(result, { sessionRequested: sessionId }) + eventsBlock)
    } catch (cause) {
      log('error', `${resume ? 'resume' : 'run'} crashed: ${cause.message}`)
      return errorResult(formatFailure(`DSH 子进程启动失败：${cause.message}`))
    }
  }

  /** 子进程环境：清宿主上下文，补 DSH_HOME / 权限模式 / Electron-as-node。 */
  function buildEnv() {
    const childEnv = { ...env }
    for (const key of [
      'DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL',
      'DSH_DESKTOP_DEFAULT_PROFILE', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE',
    ]) delete childEnv[key]
    childEnv.DSH_HOME = options.dshHome
    childEnv.DSH_PERMISSION_MODE = options.permissionMode
    childEnv.DSH_CODEX_MCP = '1'
    childEnv.NO_COLOR = childEnv.NO_COLOR ?? '1'
    childEnv.FORCE_COLOR = '0'
    Object.assign(childEnv, runtime.node.envPatch ?? {})
    return childEnv
  }

  return {
    definitions,
    async call(name, args) {
      switch (name) {
        case 'dsh_env':
          return textResult(JSON.stringify(envInfo(), null, 2))
        case 'dsh_run':
          return executeRun(args, { resume: false })
        case 'dsh_resume':
          return executeRun(args, { resume: true })
        default:
          throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 })
      }
    },
  }
}

/** 给失败结果附一句可执行的下一步建议。 */
export function normalizeHint(result, options) {
  const stderr = result?.stderrTail ?? ''
  if (/MISSING_CREDENTIAL|no API key/i.test(stderr)) {
    return `headless profile 拿不到模型凭据。请确认 ${options.dshHome}\\profiles\\headless\\cordis.patch.yml 里已把 credentials/authorization/deepseek-account 的 disabled 设为 false（插件安装时会说明），或在启动环境里导出 DEEPSEEK_API_KEY。`
  }
  if (/unknown option '--json'|unknown option "--json"/.test(stderr)) {
    return '当前 profile 不是 headless：检查插件 config 的 profile 配置，并确认调用的是安装目录内 @deepseek-ai/dsh/lib/bin.js。'
  }
  if (/session .* does not exist/i.test(stderr)) {
    return 'session id 不存在（可能写错，或该会话在别的 cwd 下创建）。省略 session_id 用 dsh_run 开新会话。'
  }
  if (/workspace|cwd/i.test(stderr) && /mismatch|不一致/i.test(stderr)) {
    return '续跑必须使用与原会话相同的 cwd：把 cwd 显式传成创建该会话时的目录。'
  }
  return undefined
}
