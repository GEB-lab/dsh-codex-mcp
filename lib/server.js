/**
 * 零依赖的 Streamable HTTP MCP 服务端（JSON-RPC 2.0 over HTTP POST）。
 *
 * 为什么手写：安装目录里只有 `@modelcontextprotocol/client` 和 `core`，没有官方
 * server SDK；插件又以 `file:`/`link:` 方式安装（模块解析基准在工作区），
 * 引入任何第三方依赖都可能在 DSH 宿主里解析失败。协议本身只有几步，手写更稳。
 *
 * 支持的传输行为：
 * - POST <path>       JSON-RPC 请求/通知/批量；initialize 时下发 Mcp-Session-Id
 * - GET  <path>       SSE 通道（仅保活注释行），避免只支持 SSE 的客户端直接失败
 * - DELETE <path>     结束会话
 * 鉴权：Authorization: Bearer <token>
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05', '2024-10-07']
const DEFAULT_PROTOCOL_VERSION = '2025-06-18'
const MAX_BODY_BYTES = 4 * 1024 * 1024

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest()
}

/** 常量时间比较，避免长度/前缀泄漏。 */
export function safeEqual(a, b) {
  return timingSafeEqual(digest(a), digest(b))
}

function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

/**
 * @param {object} deps
 * @param {object} deps.options 归一化配置
 * @param {object} deps.tools createTools() 的返回值
 * @param {object} deps.strings 本地化文案
 * @param {object} deps.runtime 运行期信息（port / running / ...）
 * @param {(level: string, message: string) => void} [deps.log]
 */
export function createMcpHttpServer({ options, tools, strings, runtime, log = () => {} }) {
  const sessions = new Set()
  const serverInfo = { name: options.pluginName, title: strings.serverTitle, version: runtime.pluginVersion }

  const sendJson = (response, status, payload, extraHeaders = {}) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8')
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    })
    response.end(body)
  }

  const sendRpcError = (response, status, id, code, message, extraHeaders = {}) => {
    sendJson(response, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } }, extraHeaders)
  }

  const unauthorized = (response) => {
    sendRpcError(response, 401, null, -32001, 'unauthorized: missing or invalid Bearer token', {
      'WWW-Authenticate': 'Bearer realm="dsh-codex-mcp"',
    })
  }

  function authorized(request) {
    const header = request.headers.authorization ?? request.headers.Authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    return safeEqual(match[1].trim(), options.token)
  }

  /** 处理单条 JSON-RPC 消息，返回响应对象；通知返回 null。 */
  async function handleMessage(message, sessionId) {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request: expected a JSON-RPC object' } }
    }
    const hasId = Object.prototype.hasOwnProperty.call(message, 'id') && message.id !== null && message.id !== undefined
    const id = hasId ? message.id : null
    const method = message.method
    if (typeof method !== 'string') {
      if (!hasId) return null
      return { jsonrpc: '2.0', id, error: { code: -32600, message: 'invalid request: missing method' } }
    }
    // 通知：不产生响应
    if (!hasId) {
      if (method === 'notifications/cancelled' || method === 'notifications/initialized' || method === 'notifications/roots/list_changed') {
        log('debug', `notification ${method}`)
      }
      return null
    }

    const params = message.params ?? {}
    try {
      switch (method) {
        case 'initialize': {
          const requested = params?.protocolVersion
          const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : DEFAULT_PROTOCOL_VERSION
          const newSession = `session-${options.pluginName}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
          sessions.add(newSession)
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion,
              capabilities: { tools: { listChanged: false } },
              serverInfo,
              instructions: strings.instructions,
            },
            // 由调用方提升为响应头
            [SESSION_HEADER]: newSession,
          }
        }
        case 'ping':
          return { jsonrpc: '2.0', id, result: {} }
        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: tools.definitions } }
        case 'tools/call': {
          const name = params?.name
          if (typeof name !== 'string' || name.length === 0) {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'invalid params: name is required' } }
          }
          const known = tools.definitions.some((tool) => tool.name === name)
          if (!known) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } }
          const result = await tools.call(name, params?.arguments ?? {})
          return { jsonrpc: '2.0', id, result }
        }
        case 'resources/list':
          return { jsonrpc: '2.0', id, result: { resources: [] } }
        case 'prompts/list':
          return { jsonrpc: '2.0', id, result: { prompts: [] } }
        case 'logging/setLevel':
          return { jsonrpc: '2.0', id, result: {} }
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
      }
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: Number.isInteger(error?.code) ? error.code : -32603, message: String(error?.message ?? error) },
      }
    }
    // sessionId 当前只用于会话登记，保留参数以便将来做有状态通知
    void sessionId
  }

  async function handlePost(request, response) {
    if (!authorized(request)) return unauthorized(response)
    const chunks = []
    let size = 0
    for await (const chunk of request) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        sendRpcError(response, 413, null, -32600, 'payload too large')
        return
      }
      chunks.push(chunk)
    }
    const text = Buffer.concat(chunks).toString('utf8').trim()
    if (text.length === 0) {
      sendRpcError(response, 400, null, -32700, 'parse error: empty body')
      return
    }
    let payload
    try {
      payload = JSON.parse(text)
    } catch (error) {
      sendRpcError(response, 400, null, -32700, `parse error: ${error.message}`)
      return
    }

    const headerSession = request.headers['mcp-session-id']
    const sessionId = typeof headerSession === 'string' ? headerSession : undefined

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        sendRpcError(response, 400, null, -32600, 'invalid request: empty batch')
        return
      }
      const answers = []
      let sessionHeader
      for (const message of payload) {
        const answer = await handleMessage(message, sessionId)
        if (answer === null) continue
        sessionHeader = answer[SESSION_HEADER] ?? sessionHeader
        delete answer[SESSION_HEADER]
        answers.push(answer)
      }
      if (answers.length === 0) {
        response.writeHead(202).end()
        return
      }
      sendJson(response, 200, answers, sessionHeader ? { 'Mcp-Session-Id': sessionHeader } : {})
      return
    }

    const answer = await handleMessage(payload, sessionId)
    if (answer === null) {
      response.writeHead(202, { 'Content-Length': '0' }).end()
      return
    }
    const sessionHeader = answer[SESSION_HEADER]
    delete answer[SESSION_HEADER]
    sendJson(response, 200, answer, sessionHeader ? { 'Mcp-Session-Id': sessionHeader } : {})
  }

  function handleGet(request, response) {
    if (!authorized(request)) return unauthorized(response)
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    response.write(': dsh-codex-mcp keep-alive\n\n')
    const timer = setInterval(() => {
      try {
        response.write(': ping\n\n')
      } catch {
        clearInterval(timer)
      }
    }, 20_000)
    if (typeof timer.unref === 'function') timer.unref()
    const stop = () => clearInterval(timer)
    request.on('close', stop)
    response.on('close', stop)
    response.on('error', stop)
  }

  function handleDelete(request, response) {
    if (!authorized(request)) return unauthorized(response)
    const sessionId = request.headers['mcp-session-id']
    if (typeof sessionId === 'string') sessions.delete(sessionId)
    sendJson(response, 200, { ok: true })
  }

  const httpServer = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    if (pathname !== options.path) {
      sendRpcError(response, 404, null, -32601, `not found: ${pathname}`)
      return
    }
    // 纵深防御：即使 host 配置被改成 0.0.0.0，也只接受本机来源
    if (!isLoopbackAddress(request.socket.remoteAddress) && options.allowNonLoopback !== true) {
      sendRpcError(response, 403, null, -32001, 'forbidden: remote address is not loopback', {})
      return
    }
    switch (request.method) {
      case 'POST':
        handlePost(request, response).catch((error) => {
          log('error', `POST handler failed: ${error?.stack ?? error}`)
          if (!response.headersSent) sendRpcError(response, 500, null, -32603, `internal error: ${error?.message ?? error}`)
          else response.end()
        })
        return
      case 'GET':
        handleGet(request, response)
        return
      case 'DELETE':
        handleDelete(request, response)
        return
      case 'OPTIONS':
        response.writeHead(204, {
          Allow: 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, MCP-Protocol-Version',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        }).end()
        return
      default:
        sendRpcError(response, 405, null, -32601, `method not allowed: ${request.method}`, { Allow: 'GET, POST, DELETE, OPTIONS' })
    }
  })

  httpServer.on('clientError', (error, socket) => {
    try {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    } catch {
      /* 忽略 */
    }
    log('warn', `client error: ${error.message}`)
  })

  return { server: httpServer, sessions }
}

export const SESSION_HEADER = Symbol.for('dsh-codex-mcp:session-header')
