/**
 * 本地化文案加载：locale/<lang>.json。找不到就退回 zh，再退回内置最小文案，
 * 保证插件在任何安装方式下都不会因为缺文件而启动失败。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const FALLBACK = {
  serverTitle: 'DSH Codex MCP',
  instructions: 'Use dsh_env to inspect the environment, dsh_run to start a DSH task, dsh_resume to continue a session with the same cwd.',
  tools: {
    dsh_env: { title: 'DSH environment check', description: 'Environment and configuration report.' },
    dsh_run: {
      title: 'Run a task with DSH',
      description: 'Start a DSH headless session for one task.',
      task: 'Task text passed to DSH stdin.',
      cwd: 'Working directory (absolute, must exist).',
      timeout_sec: 'Timeout in seconds.',
    },
    dsh_resume: {
      title: 'Resume a DSH session',
      description: 'Continue an existing DSH session with the same cwd.',
      session_id: 'Session id from a previous dsh_run/dsh_resume.',
    },
    common: { include_events: 'Attach the NDJSON event tail.' },
  },
}

function readLocaleFile(name) {
  const path = join(ROOT, 'locale', `${name}.json`)
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** 读取本地化文案，合并到 fallback 之上，保证字段齐全。 */
export function loadStrings(locale = 'zh') {
  const candidates = [String(locale ?? '').trim(), 'zh', 'en'].filter((name) => name.length > 0)
  for (const name of candidates) {
    try {
      const data = readLocaleFile(name)
      return {
        ...FALLBACK,
        ...data,
        tools: { ...FALLBACK.tools, ...(data.tools ?? {}) },
      }
    } catch {
      /* 试下一个 */
    }
  }
  return FALLBACK
}
