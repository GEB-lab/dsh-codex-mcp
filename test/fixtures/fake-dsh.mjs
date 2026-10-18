/**
 * 测试替身：模拟 `dsh --profile headless --json` 的契约。
 * 行为由环境变量 FAKE_DSH_SCENARIO 决定，任务文本从 stdin 读取。
 */
const scenario = process.env.FAKE_DSH_SCENARIO ?? 'ok'
const argv = process.argv.slice(2)
const sessionArgIndex = argv.indexOf('--session-id')
const resumed = sessionArgIndex >= 0 ? argv[sessionArgIndex + 1] : undefined
const sessionId = resumed ?? 'session-fake-0001'

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

let task = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  task += chunk
})
process.stdin.on('end', () => {
  // 断言调用方确实传了 --json 和 profile
  if (!argv.includes('--json') || !argv.includes('headless')) {
    process.stderr.write(`fake-dsh: unexpected argv ${JSON.stringify(argv)}\n`)
    process.exit(64)
  }
  emit({ type: 'session', sessionId, cwd: process.cwd() })

  switch (scenario) {
    case 'exit1':
      process.stderr.write('dsh: MISSING_CREDENTIAL: llm-deepseek: no API key for provider route "deepseek-official"\n')
      process.exit(1)
      break
    case 'aborted':
      emit({ type: 'status', phase: 'turn_start', turn: 1 })
      emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 })
      emit({ type: 'text', text: 'half' })
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'interrupted' } })
      process.exit(0)
      break
    case 'empty':
      emit({ type: 'status', phase: 'turn_start', turn: 1 })
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({ type: 'final', text: '   ' })
      process.exit(0)
      break
    case 'slow': {
      emit({ type: 'status', phase: 'turn_start', turn: 1 })
      emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 })
      // 卡住，等宿主超时后强杀
      setInterval(() => {}, 1000)
      break
    }
    case 'noise':
      // stdout 里混入非 JSON 行，验证解析器容错
      process.stdout.write('not json at all\n')
      emit({ type: 'status', phase: 'turn_start', turn: 1 })
      emit({ type: 'status', phase: 'step_start', turn: 1, step: 1 })
      emit({ type: 'text', text: 'OK' })
      emit({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 11, outputTokens: 2, totalTokens: 13 } })
      emit({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
      emit({ type: 'final', text: 'OK' })
      process.exit(0)
      break
    case 'ok':
    default:
      emit({ type: 'status', phase: 'turn_start', turn: resumed === undefined ? 1 : 2 })
      emit({ type: 'status', phase: 'step_start', turn: resumed === undefined ? 1 : 2, step: 1 })
      emit({ type: 'thinking', text: 'thinking about it' })
      emit({ type: 'text', text: 'FINAL_' })
      emit({ type: 'text', text: `TASK=${task.trim()}` })
      emit({
        type: 'status',
        phase: 'step_end',
        turn: resumed === undefined ? 1 : 2,
        step: 1,
        usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 50, cacheWriteTokens: 0, totalTokens: 157 },
      })
      emit({ type: 'status', phase: 'turn_end', turn: resumed === undefined ? 1 : 2, reason: { kind: 'completed' } })
      emit({ type: 'final', text: `FINAL_TASK=${task.trim()}` })
      process.exit(0)
  }
})
