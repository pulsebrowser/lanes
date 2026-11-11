import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The guard hooks read their project settings from .claude/brain.json (scripts/ci/brain-config.mjs, 2026-11-11),
 * so they can move to a public plugin with no Pulse names or paths inside. This test gives them another project
 * (owner "Ada", protected branch "trunk", its own covered-file list and lane folder) and checks every hook follows it.
 */
const hook = (name) => path.join(process.cwd(), 'scripts', name)
let dir = ''
let repo = ''
let config = ''

const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
const run = (name, input, env = {}) => {
  const r = spawnSync('node', [hook(name)], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: repo, BRAIN_CONFIG: config, LANE_REGISTRY: '', CLAUDE_CODE_HOST_SESSION_ID: '', ...env },
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: repo })

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'brain-config-'))
  repo = path.join(dir, 'project')
  mkdirSync(path.join(repo, 'checks'), { recursive: true })
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'trunk'], { cwd: repo })
  writeFileSync(path.join(repo, 'src/money.ts'), 'export const a = 1\n')
  git('add', 'src/money.ts')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a')
  writeFileSync(path.join(repo, 'src/money.ts'), 'export const a = 2\n')
  writeFileSync(path.join(repo, 'checks/covered.json'), JSON.stringify({ money: ['src/money.ts'] }))

  const lanes = path.join(dir, 'lanes')
  mkdirSync(lanes)
  writeFileSync(
    path.join(lanes, 'lanes.json'),
    JSON.stringify({ lanes: [{ slug: 'core', name: 'Core', sessionId: 'local_core', keywords: ['ledger'] }] }),
  )
  config = path.join(dir, 'brain.json')
  writeFileSync(
    config,
    JSON.stringify({
      owner: 'Ada',
      protectedBranch: 'trunk',
      lanesDir: lanes,
      scheduledTasksDir: path.join(dir, 'no-tasks'),
      secondReader: { coveredFiles: 'checks/covered.json', verifyCommand: 'make verify', skill: 'docs/reader.md' },
    }),
  )
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('brain config', () => {
  it('main push guard protects the configured branch and takes the owner\'s word', () => {
    const stopped = run('main-push-guard.mjs', bash('git push origin trunk'))
    expect(stopped.code).toBe(2)
    expect(stopped.err).toContain('changes reach trunk through a pull request')
    expect(stopped.err).toContain("# main-push: Ada's word")
    expect(run('main-push-guard.mjs', bash('git push origin main')).code).toBe(0)
    expect(run('main-push-guard.mjs', bash("git push origin trunk # main-push: Ada's word")).code).toBe(0)
    expect(run('main-push-guard.mjs', bash("git push origin trunk # main-push: Bob's word")).code).toBe(2)
  })

  it('second reader reads the configured covered-file list and names the configured steps', () => {
    git('add', 'src/money.ts')
    const r = run('second-reader-guard.mjs', bash('git commit -m "change money"'))
    expect(r.code).toBe(2)
    expect(r.err).toContain('money: src/money.ts')
    expect(r.err).toContain('Run make verify money')
    expect(r.err).toContain('second read (docs/reader.md)')
    expect(r.err).toContain("Second-Reader: skipped on Ada's word")
    git('reset', '-q')
  })

  it('lane hooks read lanes.json from the configured folder', () => {
    const lane = run('lane-guard.mjs', { prompt: 'lane: core', session_id: 's' })
    expect(lane.code).toBe(0)
    expect(lane.out).toContain(`read its state file ${path.join(dir, 'lanes', 'core.md')}`)
    const guard = run('lane-guard.mjs', { prompt: 'fix the ledger totals', session_id: 's' })
    expect(guard.code).toBe(2)
    expect(guard.err).toContain('this looks like Core work')
    const pr = run('lane-pr-guard.mjs', bash('gh pr create --fill'), { CLAUDE_CODE_HOST_SESSION_ID: 'local_core' })
    expect(pr.code).toBe(2)
  })

  it('a missing config file gives the defaults, so the hooks still run', () => {
    const missing = { BRAIN_CONFIG: path.join(dir, 'nope.json') }
    const r = run('main-push-guard.mjs', bash('git push origin main'), missing)
    expect(r.code).toBe(2)
    expect(r.err).toContain("# main-push: the owner's word")
  })
})
