#!/usr/bin/env node
/**
 * HTTP smoke test: connects to the plugin's MCP endpoint exactly like Codex
 * would, and walks initialize → tools/list → dsh_env → optional dsh_run.
 *
 * Usage:
 *   node scripts/smoke.mjs                       # protocol + dsh_env only (no tokens spent)
 *   node scripts/smoke.mjs --task "reply SMOKE_OK" --cwd /path/to/project
 *   node scripts/smoke.mjs --url http://127.0.0.1:39391/mcp --token <token>
 *
 * The token comes from --token, then DSH_CODEX_MCP_TOKEN, then the token file
 * ($DSH_HOME/codex-mcp.token, i.e. ~/.dsh/codex-mcp.token by default).
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  if (index >= 0 && args[index + 1] !== undefined) return args[index + 1]
  return fallback
}

const url = arg('url', 'http://127.0.0.1:39391/mcp')
const task = arg('task')
const cwd = arg('cwd')
const timeoutSec = Number(arg('timeout', '3600'))
let token = arg('token', process.env.DSH_CODEX_MCP_TOKEN)
if (token === undefined) {
  const tokenFile = arg('token-file', join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'codex-mcp.token'))
  token = readFileSync(tokenFile, 'utf8').trim()
}

let id = 0
async function rpc(method, params) {
  const body = { jsonrpc: '2.0', id: ++id, method }
  if (params !== undefined) body.params = params
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 500)}`)
  const payload = JSON.parse(text)
  if (payload.error !== undefined) throw new Error(`JSON-RPC ${payload.error.code}: ${payload.error.message}`)
  return payload.result
}

const ok = (label, detail = '') => console.log(`  ✔ ${label}${detail ? ` — ${detail}` : ''}`)

try {
  console.log(`[smoke] ${url}`)

  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'dsh-codex-mcp-smoke', version: '0.1.0' },
  })
  ok('initialize', `${init.serverInfo.name}@${init.serverInfo.version}, protocol ${init.protocolVersion}`)

  const list = await rpc('tools/list')
  ok('tools/list', list.tools.map((tool) => tool.name).join(', '))

  const envCall = await rpc('tools/call', { name: 'dsh_env', arguments: {} })
  const info = JSON.parse(envCall.content[0].text)
  ok('dsh_env', `dsh ${info.dsh.version} @ ${info.dsh.cli}`)
  ok('dsh_env profile', `${info.dsh.profile} · ${info.dsh.permissionMode} · node ${info.dsh.nodeVersion}`)
  console.log('\n把下面这段贴进 Codex 的 config.toml：\n')
  console.log(info.codexConfig.replace(/\n/g, '\n'))

  if (task !== undefined) {
    console.log(`\n[smoke] dsh_run: ${task}`)
    const startedAt = Date.now()
    const runCall = await rpc('tools/call', {
      name: 'dsh_run',
      arguments: { task, ...(cwd ? { cwd } : {}), timeout_sec: timeoutSec },
    })
    const text = runCall.content[0].text
    if (runCall.isError === true) {
      console.error('\n✖ dsh_run 失败：\n')
      console.error(text)
      process.exit(1)
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log(`\n${text}\n`)
    ok('dsh_run', `${seconds}s, isError=false`)
  } else {
    console.log('\n（没给 --task，跳过真实任务；加 --task "只回复 SMOKE_OK" 可验证一次 headless 调用）')
  }
  console.log('\n[smoke] 全部通过')
} catch (error) {
  console.error(`\n✖ [smoke] 失败：${error.message}`)
  process.exit(1)
}
