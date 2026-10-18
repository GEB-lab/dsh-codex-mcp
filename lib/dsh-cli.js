/**
 * 定位两样东西：DSH 的 headless CLI 入口（bin.js）和可用的 node 运行时。
 *
 * 为什么不用 PATH 上的 `dsh`：
 * - PATH 里的 `dsh.cmd` 是 Desktop 启动器（会注入 `--profile desktop`，还依赖
 *   `host-commands/generations/<hash>` 那个目录，桌面升级后可能失效）；
 * - npm 全局的 `dsh` 是另一个更旧的版本（0.1.2-rc.1）。
 * 直接指向安装目录里的 `@deepseek-ai/dsh/lib/bin.js` 才是稳定入口。
 */
import { existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 候选 bin.js 路径（按优先级去重）。 */
export function candidateDshCli(env = process.env) {
  const list = []
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0 && !list.includes(value)) list.push(value)
  }
  // 1) 插件跑在 Electron 宿主里时，process.resourcesPath 指向 ...\resources
  if (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0) {
    push(join(process.resourcesPath, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  // 2) 从可执行文件位置反推 ...\DSH Desktop\resources\app\...
  if (process.execPath) {
    const exeDir = dirname(process.execPath)
    push(join(exeDir, 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    push(join(exeDir, '..', 'resources', 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  }
  // 3) 环境变量显式指定安装目录
  if (env.DSH_APP_ROOT) push(join(env.DSH_APP_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
  return list
}

/** 解析 DSH CLI 入口；显式配置优先，其次按候选顺序找第一个存在的文件。 */
export function resolveDshCli(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`dsh-codex-mcp: configured dshCli does not exist: ${explicit}`)
    return explicit
  }
  const candidates = candidateDshCli()
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  throw new Error(
    'dsh-codex-mcp: cannot locate @deepseek-ai/dsh/lib/bin.js. '
    + `Tried:\n${candidates.map((item) => `  - ${item}`).join('\n')}\n`
    + '请在插件 config 里显式设置 dshCli。',
  )
}

/** 读取 DSH 版本（bin.js 位于 <pkg>/lib/bin.js，包的 package.json 在上面两级）。 */
export function readDshVersion(cliPath) {
  try {
    const text = readFileSync(join(dirname(dirname(cliPath)), 'package.json'), 'utf8')
    return JSON.parse(text).version
  } catch {
    return undefined
  }
}

/** 在 PATH 里找可执行文件（Windows 按 PATHEXT 展开）。 */
export function findOnPath(command, env = process.env) {
  const pathValue = env.PATH ?? env.Path ?? ''
  const exts = process.platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : ['']
  const separator = process.platform === 'win32' ? ';' : ':'
  for (const rawDir of pathValue.split(separator)) {
    const dir = rawDir.trim()
    if (dir.length === 0) continue
    for (const ext of exts) {
      for (const name of ext === '' ? [command] : [`${command}${ext}`, `${command}${ext.toLowerCase()}`, command]) {
        const candidate = join(dir, name)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

/**
 * 决定用什么跑 bin.js。
 * - 显式 nodePath 优先；
 * - 其次 PATH 上的 node（本地实测 v24.16.0）；
 * - 最后回落到 Electron 自带的 Node（`ELECTRON_RUN_AS_NODE=1` + 宿主 exe），
 *   这也正是 Desktop 自己的 dsh.cmd 用的办法。
 * @returns {{ command: string, envPatch: Record<string,string>, kind: 'node'|'electron' }}
 */
export function resolveNode(explicit, env = process.env) {
  if (explicit) return { command: explicit, envPatch: {}, kind: 'node' }
  const onPath = findOnPath('node', env)
  if (onPath !== undefined) return { command: onPath, envPatch: {}, kind: 'node' }
  if (process.execPath && /electron|dsh desktop/i.test(basename(process.execPath))) {
    return { command: process.execPath, envPatch: { ELECTRON_RUN_AS_NODE: '1' }, kind: 'electron' }
  }
  if (process.execPath) return { command: process.execPath, envPatch: {}, kind: 'node' }
  throw new Error('dsh-codex-mcp: no node runtime available; set config.nodePath explicitly')
}
