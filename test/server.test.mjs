/**
 * 协议层 + 子进程编排的自测（不依赖 DSH 宿主，用 fake-dsh.mjs 当 CLI 替身）。
 * 运行：node --test test/*.test.mjs   （Node 24；不要写 `node --test test`，那会把目录当模块）
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { startCodexMcpServer } from '../index.js'
import { resolveTaskCwd, resolveTimeoutSec } from '../lib/tools.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/fake-dsh.mjs', import.meta.url))

let sandbox
let handle
let url
let token

before(async () => {
  sandbox = mkdtempSync(join(tmpdir(), 'dsh-codex-mcp-test-'))
  handle = startCodexMcpServer(
    {
      host: '127.0.0.1',
      port: 0,
      path: '/mcp',
      tokenFile: join(sandbox, 'codex-mcp.token'),
      dshHome: sandbox,
      dshCli: FIXTURE,
      nodePath: process.execPath,
      defaultTimeoutSec: 60,
      locale: 'zh',
    },
    { log: () => {} },
  )
  await handle.listen()
  url = handle.url
  token = handle.options.token
})

after(() => {
  handle?.dispose()
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
})

async function rpc(body, { auth = token, headers = {} } = {}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(auth === null ? {} : { authorization: `Bearer ${auth}` }),
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return {
    status: response.status,
    headers: response.headers,
    body: text.length > 0 ? JSON.parse(text) : undefined,
  }
}

const initRequest = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }

function toolCall(id, name, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

describe('transport', () => {
  it('拒绝没有 Bearer token 的请求', async () => {
    const result = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { auth: null })
    assert.equal(result.status, 401)
    assert.equal(result.body.error.code, -32001)
  })

  it('拒绝错误的 token', async () => {
    const result = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { auth: 'wrong-token' })
    assert.equal(result.status, 401)
  })

  it('initialize 返回协议版本、指令和会话头', async () => {
    const result = await rpc(initRequest)
    assert.equal(result.status, 200)
    assert.equal(result.body.result.protocolVersion, '2025-06-18')
    assert.equal(result.body.result.serverInfo.name, 'dsh-codex-mcp')
    assert.match(result.body.result.instructions, /dsh_run/)
    assert.ok(result.headers.get('mcp-session-id'), 'missing Mcp-Session-Id header')
  })

  it('批量请求按数组返回', async () => {
    const result = await rpc([
      { jsonrpc: '2.0', id: 'a', method: 'ping' },
      { jsonrpc: '2.0', id: 'b', method: 'tools/list' },
    ])
    assert.equal(result.status, 200)
    assert.ok(Array.isArray(result.body))
    assert.equal(result.body.length, 2)
  })

  it('notification 返回 202 且无 body', async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    })
    assert.equal(response.status, 202)
    assert.equal(await response.text(), '')
  })

  it('未知方法返回 -32601', async () => {
    const result = await rpc({ jsonrpc: '2.0', id: 9, method: 'nope/whatever' })
    assert.equal(result.body.error.code, -32601)
  })

  it('未知路径返回 404', async () => {
    const response = await fetch(url.replace('/mcp', '/other'), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 404)
  })

  it('GET 提供 SSE 保活通道，DELETE 结束会话', async () => {
    const controller = new AbortController()
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const reader = response.body.getReader()
    const first = await reader.read()
    assert.match(Buffer.from(first.value).toString('utf8'), /keep-alive/)
    controller.abort()

    const deleted = await fetch(url, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
    assert.equal(deleted.status, 200)
  })
})

describe('tools', () => {
  it('tools/list 只暴露三个工具', async () => {
    const result = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const names = result.body.result.tools.map((tool) => tool.name)
    assert.deepEqual(names, ['dsh_env', 'dsh_run', 'dsh_resume'])
  })

  it('dsh_env 返回地址、token 和 Codex 配置片段', async () => {
    const result = await rpc(toolCall(3, 'dsh_env', {}))
    const info = JSON.parse(result.body.result.content[0].text)
    assert.equal(info.mcp.url, url)
    assert.equal(info.mcp.token, token)
    assert.equal(info.dsh.profile, 'headless')
    assert.equal(info.dsh.permissionMode, 'danger-full-access')
    assert.match(info.codexConfig, /\[mcp_servers\.dsh_codex\]/)
    assert.match(info.codexConfig, /Authorization = "Bearer /)
    // 替身 CLI 不在 @deepseek-ai/dsh 包里，版本应为 undefined；真实安装下会读到 0.2.1-rc.2
    assert.equal(info.dsh.cli, FIXTURE)
    assert.equal(info.dsh.node, process.execPath)
  })

  it('dsh_run 成功时返回最终答案、session 与用量', async () => {
    process.env.FAKE_DSH_SCENARIO = 'ok'
    const result = await rpc(toolCall(4, 'dsh_run', { task: 'hello world' }))
    const payload = result.body.result
    assert.equal(payload.isError, false)
    const text = payload.content[0].text
    assert.match(text, /FINAL_TASK=hello world/)
    assert.match(text, /session: session-fake-0001/)
    assert.match(text, /turn_end: completed/)
    assert.match(text, /usage: in 100 \/ out 7/)
    assert.match(text, /dsh_resume/)
  })

  it('dsh_run 容忍 stdout 里的非 JSON 噪声行', async () => {
    process.env.FAKE_DSH_SCENARIO = 'noise'
    const result = await rpc(toolCall(5, 'dsh_run', { task: 'noise test' }))
    assert.equal(result.body.result.isError, false)
    assert.match(result.body.result.content[0].text, /OK/)
  })

  it('dsh_resume 把 session_id 传给子进程', async () => {
    process.env.FAKE_DSH_SCENARIO = 'ok'
    const result = await rpc(toolCall(6, 'dsh_resume', { session_id: 'session-fake-9999', task: 'continue' }))
    const text = result.body.result.content[0].text
    assert.equal(result.body.result.isError, false)
    assert.match(text, /session: session-fake-9999/)
    assert.match(text, /turn 2/)
  })

  it('非零退出码判为失败并带 stderr 诊断与提示', async () => {
    process.env.FAKE_DSH_SCENARIO = 'exit1'
    const result = await rpc(toolCall(7, 'dsh_run', { task: 'will fail' }))
    const payload = result.body.result
    assert.equal(payload.isError, true)
    assert.match(payload.content[0].text, /MISSING_CREDENTIAL/)
    assert.match(payload.content[0].text, /cordis\.patch\.yml/)
  })

  it('空最终答案判为失败', async () => {
    process.env.FAKE_DSH_SCENARIO = 'empty'
    const result = await rpc(toolCall(8, 'dsh_run', { task: 'empty answer' }))
    assert.equal(result.body.result.isError, true)
    assert.match(result.body.result.content[0].text, /最终答案为空/)
  })

  it('turn_end 不是 completed 判为失败', async () => {
    process.env.FAKE_DSH_SCENARIO = 'aborted'
    const result = await rpc(toolCall(9, 'dsh_run', { task: 'aborted' }))
    assert.equal(result.body.result.isError, true)
    assert.match(result.body.result.content[0].text, /turn_end 不是 completed/)
  })

  it('超时会强杀进程树并判为失败', async () => {
    process.env.FAKE_DSH_SCENARIO = 'slow'
    const startedAt = Date.now()
    const result = await rpc(toolCall(10, 'dsh_run', { task: 'hang', timeout_sec: 1 }))
    const elapsed = Date.now() - startedAt
    assert.equal(result.body.result.isError, true)
    assert.match(result.body.result.content[0].text, /超时/)
    assert.ok(elapsed < 20000, `timeout took too long: ${elapsed}ms`)
  })

  it('参数校验：空 task / 非法超时 / 不存在的 cwd', async () => {
    const empty = await rpc(toolCall(11, 'dsh_run', { task: '   ' }))
    assert.equal(empty.body.result.isError, true)
    assert.match(empty.body.result.content[0].text, /task 必须是非空字符串/)

    const badTimeout = await rpc(toolCall(12, 'dsh_run', { task: 'x', timeout_sec: -5 }))
    assert.equal(badTimeout.body.result.isError, true)
    assert.match(badTimeout.body.result.content[0].text, /timeout_sec/)

    const badCwd = await rpc(toolCall(13, 'dsh_run', { task: 'x', cwd: join(sandbox, 'does-not-exist') }))
    assert.equal(badCwd.body.result.isError, true)
    assert.match(badCwd.body.result.content[0].text, /cwd does not exist/)

    const noSession = await rpc(toolCall(14, 'dsh_resume', { task: 'x' }))
    assert.equal(noSession.body.result.isError, true)
    assert.match(noSession.body.result.content[0].text, /session_id/)
  })
})

describe('helpers', () => {
  it('resolveTaskCwd / resolveTimeoutSec', () => {
    assert.throws(() => resolveTaskCwd(undefined, join(sandbox, 'nope')), /does not exist/)
    assert.equal(resolveTaskCwd(undefined, sandbox), sandbox)
    assert.equal(resolveTimeoutSec(undefined, 42), 42)
    assert.throws(() => resolveTimeoutSec('abc', 42), /positive number/)
    assert.equal(resolveTimeoutSec(999999, 42), 86400)
  })
})
