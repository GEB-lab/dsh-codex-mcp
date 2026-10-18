/**
 * 起一个 headless DSH 子进程跑一个任务，把 `--json` 的 NDJSON 事件流折成结构化结果。
 *
 * 契约（见 @deepseek-ai/dsh-headless）：
 *   node <bin.js> --profile headless --json [--session-id <id>]
 * 任务来自 stdin；stdout 是 NDJSON：session / status(turn_start|step_start|step_end|turn_end) /
 * thinking / text / final；成功时退出码 0，失败时 1 并把 `dsh: <code>: <message>` 写到 stderr。
 */
import { spawn, spawnSync } from 'node:child_process'

const SCRUBBED_ENV = [
  // 宿主自己的 profile/会话上下文，绝不能漏给子进程
  'DSH_PROFILE',
  'DSH_PROFILE_DIR',
  'DSH_SESSION_ID',
  'DSH_SHELL',
  'DSH_WEB_URL',
  'DSH_DESKTOP_DEFAULT_PROFILE',
  // Electron 相关：只在需要 Electron 当 node 用时才手动加回去
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_RUN_AS_NODE_DISABLE',
]

const STDERR_TAIL_BYTES = 8192
const MAX_EVENT_BYTES = 32 * 1024

/** 构造子进程环境：清掉宿主上下文，补齐 DSH_HOME / 权限模式。 */
export function buildChildEnv({ env = process.env, dshHome, permissionMode, nodeEnvPatch = {}, extraEnv = {} } = {}) {
  const childEnv = { ...env }
  for (const key of SCRUBBED_ENV) delete childEnv[key]
  childEnv.DSH_HOME = dshHome
  childEnv.DSH_PERMISSION_MODE = permissionMode
  childEnv.DSH_CODEX_MCP = '1'
  // 关掉颜色/交互提示，避免 ANSI 噪声进事件流
  childEnv.NO_COLOR = childEnv.NO_COLOR ?? '1'
  childEnv.FORCE_COLOR = '0'
  Object.assign(childEnv, nodeEnvPatch, extraEnv)
  return childEnv
}

/** 强杀整棵进程树（Windows 用 taskkill /T，其它平台杀掉进程组）。 */
export function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    if (result.status === 0) return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* 进程已经退出 */
    }
  }
}

/** 把一条 NDJSON 事件并进累计状态。 */
function foldEvent(state, event) {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') {
    state.malformed += 1
    return
  }
  state.eventCounts[event.type] = (state.eventCounts[event.type] ?? 0) + 1
  switch (event.type) {
    case 'session':
      if (typeof event.sessionId === 'string') state.sessionId = event.sessionId
      if (typeof event.cwd === 'string') state.cwd = event.cwd
      break
    case 'status':
      if (event.phase === 'turn_start') {
        state.turns = Math.max(state.turns, Number(event.turn) || 0)
      } else if (event.phase === 'step_start') {
        state.steps += 1
        state.turns = Math.max(state.turns, Number(event.turn) || 0)
      } else if (event.phase === 'step_end') {
        const usage = event.usage
        if (usage && typeof usage === 'object') {
          for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens']) {
            const value = Number(usage[key])
            if (Number.isFinite(value)) state.usage[key] = (state.usage[key] ?? 0) + value
          }
          state.lastUsage = usage
        }
      } else if (event.phase === 'turn_end') {
        state.turnEnd = event.reason && typeof event.reason === 'object' ? event.reason.kind ?? null : null
        state.turnEndReason = event.reason ?? null
      }
      break
    case 'thinking':
      if (typeof event.text === 'string') state.thinkingChars += event.text.length
      break
    case 'text':
      if (typeof event.text === 'string') state.textLog += event.text
      break
    case 'final':
      if (typeof event.text === 'string') {
        state.finalText = event.text
        state.finalSeen = true
      }
      break
    default:
      break
  }
}

/**
 * 运行一次 headless DSH。
 * @returns 结构化结果（不抛业务错误；spawn 失败才 reject）。
 */
export function runHeadless(options) {
  const {
    task,
    sessionId,
    cwd,
    timeoutSec,
    cliPath,
    profile = 'headless',
    node,
    env,
    signal,
    onSpawn,
  } = options

  const args = [cliPath, '--profile', profile, '--json']
  if (typeof sessionId === 'string' && sessionId.length > 0) args.push('--session-id', sessionId)

  const startedAt = Date.now()
  const state = {
    sessionId: sessionId ?? null,
    cwd: null,
    turns: 0,
    steps: 0,
    usage: {},
    lastUsage: undefined,
    thinkingChars: 0,
    textLog: '',
    finalText: '',
    finalSeen: false,
    turnEnd: null,
    turnEndReason: null,
    eventCounts: {},
    malformed: 0,
    events: [],
  }

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(node.command, args, {
        cwd,
        env: env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new Error(`dsh-codex-mcp: failed to spawn DSH (${node.command}): ${error.message}`))
      return
    }

    onSpawn?.(child)
    let stdoutBuffer = ''
    let stderrTail = ''
    let timedOut = false
    let settled = false
    let timer
    let graceTimer

    const finish = (payload) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      resolve({
        durationMs: Date.now() - startedAt,
        timedOut,
        events: state.events,
        eventCounts: state.eventCounts,
        malformed: state.malformed,
        sessionId: state.sessionId,
        cwd: state.cwd ?? cwd,
        turns: state.turns,
        steps: state.steps,
        usage: state.usage,
        lastUsage: state.lastUsage,
        thinkingChars: state.thinkingChars,
        textLog: state.textLog,
        finalText: state.finalSeen ? state.finalText : '',
        finalSeen: state.finalSeen,
        turnEnd: state.turnEnd,
        turnEndReason: state.turnEndReason,
        stderrTail,
        ...payload,
      })
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk
      let index = stdoutBuffer.indexOf('\n')
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index).replace(/\r$/, '')
        stdoutBuffer = stdoutBuffer.slice(index + 1)
        if (line.trim().length > 0) {
          if (line.length <= MAX_EVENT_BYTES) {
            let parsed
            try {
              parsed = JSON.parse(line)
            } catch {
              state.malformed += 1
              parsed = undefined
            }
            if (parsed !== undefined) {
              if (state.events.length < 5000) state.events.push(parsed)
              foldEvent(state, parsed)
            }
          } else {
            state.malformed += 1
          }
        }
        index = stdoutBuffer.indexOf('\n')
      }
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_BYTES)
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (graceTimer !== undefined) clearTimeout(graceTimer)
      reject(new Error(`dsh-codex-mcp: DSH process error: ${error.message}`))
    })

    child.on('close', (code, signalName) => {
      // 收尾：stdout 里可能还剩一整行没有换行
      const rest = stdoutBuffer.trim()
      if (rest.length > 0) {
        try {
          foldEvent(state, JSON.parse(rest))
        } catch {
          state.malformed += 1
        }
      }
      finish({ exitCode: code, signal: signalName ?? null })
    })

    const timeoutMs = Math.max(1, Number(timeoutSec) || 3600) * 1000
    timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
      graceTimer = setTimeout(() => {
        finish({ exitCode: null, signal: 'timeout', forced: true })
      }, 8000)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()

    if (signal !== undefined) {
      signal.addEventListener('abort', () => {
        killTree(child.pid)
      }, { once: true })
    }

    child.stdin.on('error', () => { /* 子进程提前退出时的 EPIPE，忽略 */ })
    child.stdin.end(String(task ?? ''), 'utf8')
  })
}
