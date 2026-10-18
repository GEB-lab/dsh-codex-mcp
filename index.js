/**
 * dsh-codex-mcp —— DSH Host 插件入口。
 *
 * 它做三件事：
 *  1. 在 DSH 宿主进程内启动一个本地 Streamable HTTP MCP 服务（默认 127.0.0.1:39391/mcp）；
 *  2. 用 Bearer token 鉴权（token 落盘，插件重启后不变，Codex 只配一次）；
 *  3. 把 Codex 发来的 dsh_run / dsh_resume 变成一次 headless DSH 子进程调用，
 *     把 `--json` 事件流折成"最终答案 + session + 用量"，失败时给结构化诊断。
 *
 * 注意：DSH 自己的 agent 工具只对 DSH 的模型可见，Codex 看不到，所以对外协议必须是 MCP。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeConfig } from './lib/config.js'
import { readDshVersion, resolveDshCli, resolveNode } from './lib/dsh-cli.js'
import { killTree } from './lib/runner.js'
import { createMcpHttpServer } from './lib/server.js'
import { loadStrings } from './lib/strings.js'
import { createTools } from './lib/tools.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)))

/** 插件名（cordis 加载器按它写日志/定位）。 */
export const name = 'dsh-codex-mcp'

/** 不强制依赖任何 DSH 服务：插件只用 node 内置能力。 */
export const inject = []

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** 组装运行期上下文（可注入依赖，便于独立测试）。 */
export function createRuntime(options, env = process.env) {
  const runtime = {
    pluginVersion: pluginVersion(),
    dshCli: resolveDshCli(options.dshCli),
    dshVersion: undefined,
    node: resolveNode(options.nodePath, env),
    running: new Set(),
    startedAt: new Date().toISOString(),
    port: options.port,
  }
  runtime.dshVersion = readDshVersion(runtime.dshCli)
  return runtime
}

/**
 * 启动 MCP 服务并返回句柄；调用方负责在卸载时调用 dispose。
 * 抽出来是为了能在测试里不经过 cordis 直接起服务。
 */
export function startCodexMcpServer(configRaw, { env = process.env, log = () => {} } = {}) {
  const options = normalizeConfig(configRaw, env, process.cwd())
  const strings = loadStrings(options.locale)
  const runtime = createRuntime(options, env)
  const tools = createTools({ options, runtime, strings, env, log })
  const { server } = createMcpHttpServer({ options, tools, strings, runtime, log })

  const handle = {
    options,
    runtime,
    server,
    url: `http://${options.host}:${runtime.port}${options.path}`,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening)
          reject(error)
        }
        const onListening = () => {
          server.off('error', onError)
          const address = server.address()
          if (address !== null && typeof address === 'object') runtime.port = address.port
          handle.url = `http://${options.host}:${runtime.port}${options.path}`
          resolve(handle)
        }
        server.once('error', onError)
        server.once('listening', onListening)
        server.listen(options.port, options.host)
      })
    },
    dispose() {
      for (const pid of runtime.running) killTree(pid)
      runtime.running.clear()
      try {
        server.closeAllConnections?.()
      } catch {
        /* 版本差异 */
      }
      try {
        server.close()
      } catch {
        /* 已经关闭 */
      }
    },
  }
  return handle
}

/** cordis 插件主体：把服务生命周期挂到 ctx.effect 上，随插件卸载一起回收。 */
export function apply(ctx, configRaw) {
  const logger = (() => {
    try {
      return ctx.logger?.('dsh-codex-mcp')
    } catch {
      return undefined
    }
  })()
  const log = (level, message) => {
    const text = `[dsh-codex-mcp] ${message}`
    const method = logger?.[level] ?? (level === 'error' ? logger?.warn : undefined) ?? logger?.info
    if (typeof method === 'function') {
      method.call(logger, text)
      return
    }
    const fallback = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    fallback(text)
  }

  let handle
  ctx.effect(() => {
    handle = startCodexMcpServer(configRaw, { env: process.env, log })
    handle.server.on('error', (error) => log('error', `http server error: ${error.code ?? ''} ${error.message}`.trim()))
    handle.listen().then(
      () => {
        log('info', `MCP listening on ${handle.url} — token file: ${handle.options.tokenFile}`)
        log('info', `Codex config: [mcp_servers.dsh_codex] url = "${handle.url}" + http_headers Authorization Bearer <token>`)
      },
      (error) => {
        log('error', `failed to bind ${handle.options.host}:${handle.options.port}: ${error.code ?? ''} ${error.message}`.trim())
      },
    )
    return () => {
      log('info', 'disposing dsh-codex-mcp (closing MCP server)')
      handle.dispose()
    }
  }, 'dsh-codex-mcp:local-mcp-http')
}

/** 直接 `node index.js` 时也能起一个独立服务，便于用 curl/脚本验证协议。 */
const isDirect = (() => {
  try {
    return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]
  } catch {
    return false
  }
})()

if (isDirect) {
  const handle = startCodexMcpServer({}, {
    log: (level, message) => {
      const line = `[dsh-codex-mcp] ${message}`
      if (level === 'error') console.error(line)
      else if (level === 'warn') console.warn(line)
      else console.log(line)
    },
  })
  handle.listen().then(
    () => {
      console.log(`[dsh-codex-mcp] standalone MCP server: ${handle.url}`)
      console.log(`[dsh-codex-mcp] token file: ${handle.options.tokenFile}`)
      console.log('[dsh-codex-mcp] Ctrl+C 退出')
      const shutdown = () => {
        handle.dispose()
        process.exit(0)
      }
      process.on('SIGINT', shutdown)
      process.on('SIGTERM', shutdown)
    },
    (error) => {
      console.error(`[dsh-codex-mcp] failed to listen: ${error.message}`)
      process.exit(1)
    },
  )
}
