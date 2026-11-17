import { describe, it, beforeEach, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 0.6.1, from Anthropic's "How the Claude Code team thinks about verification":
 * 1. the checker cannot edit its own rules (rules.mjs: base branch + working tree, the stricter wins);
 * 2. a Verified: line on every commit (verified-guard.mjs), counted by lane-report.mjs;
 * 3. guard modes off / observe / enforce, and a commit gate lets the third try through (guard-mode.mjs);
 * 4. `done` needs evidence (lane-inbox.mjs).
 * Each test runs in a temporary project with its own .claude/brain.json committed on `main`, then works on a branch.
 * LANES_SCRIPTS runs the same tests against another copy of the scripts (to show a test fails on the old code).
 */
const SCRIPTS = process.env.LANES_SCRIPTS || path.join(process.cwd(), 'scripts')
const root = mkdtempSync(path.join(os.tmpdir(), 'lanes-verify-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
let repo = ''
let logFile = ''
let n = 0

const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const write = (rel, text) => { mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); writeFileSync(path.join(repo, rel), text) }
const brain = (extra = {}) => JSON.stringify({ owner: 'Ada', protectedBranch: 'main', secondReader: { coveredFiles: 'checks/covered.json' }, ...extra })
const hook = (name, command, { session = 'local_s1', env = {} } = {}) => {
  const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, GUARD_LOG: logFile, ...env }
  delete e.BRAIN_CONFIG
  const r = spawnSync('node', [path.join(SCRIPTS, name)], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: repo, session_id: session }), encoding: 'utf8', env: e,
  })
  return { code: r.status, err: r.stderr, out: r.stdout }
}
const logLines = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

/** A project: main holds brain.json, the covered list and two source files; HEAD is the branch `work`. */
function project(brainText = brain()) {
  repo = path.join(root, `p${++n}`)
  logFile = path.join(root, `log${n}.jsonl`)
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  write('.claude/brain.json', brainText)
  write('checks/covered.json', JSON.stringify({ billing: ['src/billing.ts'], briefs: ['src/briefs/'] }))
  write('src/billing.ts', 'export const a = 1\n')
  write('src/other.ts', 'export const b = 1\n')
  git('add', '-A')
  git('commit', '-q', '-m', 'base')
  git('switch', '-q', '-c', 'work')
}

describe('1. the checker cannot edit its own rules', () => {
  beforeEach(() => project())

  it('stops a commit that drops a file from the covered list in the same commit', () => {
    write('checks/covered.json', JSON.stringify({ briefs: ['src/briefs/'] })) // billing removed
    write('src/billing.ts', 'export const a = 2\n')
    git('add', 'checks/covered.json', 'src/billing.ts')
    const r = hook('second-reader-guard.mjs', 'git commit -m "tidy"')
    expect(r.code).toBe(2)
    expect(r.err).toContain('billing: src/billing.ts')
    expect(r.err).toContain('guard rules: checks/covered.json')
  })

  it('stops a commit that only edits the covered list', () => {
    write('checks/covered.json', JSON.stringify({}))
    git('add', 'checks/covered.json')
    const r = hook('second-reader-guard.mjs', 'git commit -m "simplify the list"')
    expect(r.code).toBe(2)
    expect(r.err).toContain('guard rules: checks/covered.json')
    expect(hook('second-reader-guard.mjs', 'git commit -m "list" -m "Second-Reader: fresh agent, no findings"').code).toBe(0)
  })

  it('stops a commit that deletes the covered list', () => {
    git('rm', '-q', 'checks/covered.json')
    write('src/billing.ts', 'export const a = 3\n')
    git('add', 'src/billing.ts')
    const r = hook('second-reader-guard.mjs', 'git commit -m "x"')
    expect(r.code).toBe(2)
    expect(r.err).toContain('billing: src/billing.ts')
    expect(r.err).toContain('guard rules: checks/covered.json')
  })

  it('reads the list from the base branch when the working tree has none or another one', () => {
    rmSync(path.join(repo, 'checks/covered.json')) // deleted, not staged
    write('src/billing.ts', 'export const a = 4\n')
    git('add', 'src/billing.ts')
    expect(hook('second-reader-guard.mjs', 'git commit -m "x"').code).toBe(2)
    write('.claude/brain.json', brain({ secondReader: { coveredFiles: 'checks/empty.json' } })) // pointed elsewhere, not staged
    expect(hook('second-reader-guard.mjs', 'git commit -m "x"').code).toBe(2)
  })

  it('stops a commit that changes brain.json, the guards\' settings', () => {
    write('.claude/brain.json', brain({ owner: 'Bob' }))
    git('add', '.claude/brain.json')
    const r = hook('second-reader-guard.mjs', 'git commit -m "owner"')
    expect(r.code).toBe(2)
    expect(r.err).toContain('guard rules: .claude/brain.json')
  })

  it('a guard set off or to observe in the working tree stays on enforce until that is merged', () => {
    write('.claude/brain.json', brain({ guards: { secondReader: 'off', mainPush: 'off' } })) // not staged
    write('src/billing.ts', 'export const a = 5\n')
    git('add', 'src/billing.ts')
    expect(hook('second-reader-guard.mjs', 'git commit -m "x"').code).toBe(2)
    expect(hook('main-push-guard.mjs', 'git push origin main').code).toBe(2)
    write('.claude/brain.json', brain({ guards: { secondReader: 'observe' } }))
    expect(hook('second-reader-guard.mjs', 'git commit -m "x"').code).toBe(2)
  })

  it('the push guard keeps the base branch\'s protected branch when the working tree renames it', () => {
    write('.claude/brain.json', brain({ protectedBranch: 'trunk' }))
    expect(hook('main-push-guard.mjs', 'git push origin main').code).toBe(2)
    expect(hook('main-push-guard.mjs', 'git push origin trunk').code).toBe(2) // the stricter: both
    expect(hook('main-push-guard.mjs', 'git push origin work').code).toBe(0)
  })

  it('a stricter working tree counts at once: a new covered file, a gate moved to enforce', () => {
    write('checks/covered.json', JSON.stringify({ billing: ['src/billing.ts'], other: ['src/other.ts'] })) // not staged
    write('src/other.ts', 'export const b = 2\n')
    git('add', 'src/other.ts')
    expect(hook('second-reader-guard.mjs', 'git commit -m "x" -m "Verified: tests"').code).toBe(2)
    write('.claude/brain.json', brain({ guards: { verified: 'enforce' } }))
    expect(hook('verified-guard.mjs', 'git commit -m "x"').code).toBe(2)
  })
})

describe('2. the Verified line', () => {
  beforeEach(() => project(brain({ guards: { verified: 'enforce' } })))
  // A new session per call: the same session would be let through on its third blocked try (section 3).
  const verified = (command) => hook('verified-guard.mjs', command, { session: `local_v${++n}` })

  it('stops a commit with no line, an unknown kind, or "none" with no reason', () => {
    for (const msg of ['-m "fix"', '-m "fix" -m "Verified: vibes"', '-m "fix" -m "Verified: none"', '-m "fix" -m "Verified:"', '-m "Verified: none (x), tests"']) {
      expect(verified(`git commit ${msg}`).code).toBe(2)
    }
    expect(verified('git commit -m "fix"').err).toContain('Kinds: tests, app, tla, second-reader, none')
  })

  it('lets a commit through with a usable line, in -m, a heredoc, --trailer or -F', () => {
    expect(verified('git commit -m "fix" -m "Verified: tests (node --test, 152 pass), app"').code).toBe(0)
    expect(verified('git commit -m "fix" -m "Verified: none (docs only)"').code).toBe(0)
    expect(verified('git commit -m "$(cat <<\'EOF\'\nfix\n\nVerified: tla, second-reader\nCo-Authored-By: x <y@z>\nEOF\n)"').code).toBe(0)
    expect(verified('git commit -m fix --trailer "Verified: tests"').code).toBe(0)
    write('msg.txt', 'fix\n\nVerified: app (drove the page)\n')
    expect(verified('git commit -F msg.txt').code).toBe(0)
  })

  it('a reused message does not count: an amend that keeps it, -C, or "-C" inside a message', () => {
    write('src/other.ts', 'x\n'); git('add', 'src/other.ts'); git('commit', '-q', '-m', 'one', '-m', 'Verified: tests')
    write('src/other.ts', 'y\n'); git('add', 'src/other.ts')
    expect(verified('git commit --amend --no-edit').code).toBe(2)
    expect(verified('git commit -C HEAD').code).toBe(2)
    expect(verified('git commit --amend -m "one" -m "Verified: tests (again, for this diff)"').code).toBe(0)
  })

  it('in observe mode (the default) it stops nothing and logs what it would have stopped', () => {
    write('.claude/brain.json', brain()); git('add', '.claude/brain.json'); git('commit', '-q', '-m', 'observe', '-m', 'Second-Reader: x')
    git('switch', '-q', 'main'); git('merge', '-q', 'work'); git('switch', '-q', 'work') // observe is now the base too
    const r = verified('git commit -m "fix"')
    expect(r.code).toBe(0)
    expect(r.err).toBe('')
    const last = logLines().pop()
    expect(last.guard).toBe('verified')
    expect(last.decision).toBe('would-block')
    expect(last.reason).toContain('no Verified: line')
  })
})

describe('3. guard modes and the let-through', () => {
  beforeEach(() => {
    project(brain({ guards: { verified: 'enforce' } }))
    write('src/billing.ts', 'export const a = 9\n')
    git('add', 'src/billing.ts')
  })

  it('a commit gate that blocked a session twice lets the third try through, logged and shown to the user', () => {
    const cmd = 'git commit -m "x" -m "Verified: tests"'
    expect(hook('second-reader-guard.mjs', cmd).code).toBe(2)
    expect(hook('second-reader-guard.mjs', cmd).code).toBe(2)
    const third = hook('second-reader-guard.mjs', cmd)
    expect(third.code).toBe(0)
    const out = JSON.parse(third.out)
    expect(out.systemMessage).toContain('had blocked this session 2 times')
    expect(out.hookSpecificOutput.hookEventName).toBe('PreToolUse')
    expect(out.hookSpecificOutput.additionalContext).toContain('Tell Ada')
    expect(out.hookSpecificOutput.permissionDecision).toBe(undefined) // the normal permission flow stays
    expect(logLines().map((e) => e.decision).join(',')).toBe('blocked,blocked,let-through')
    expect(hook('second-reader-guard.mjs', cmd).code).toBe(2) // the count starts again
  })

  it('counts per session, and never lets through with no session id or with letThroughAfter 0', () => {
    const cmd = 'git commit -m "x" -m "Verified: tests"'
    hook('second-reader-guard.mjs', cmd, { session: 'local_a' })
    hook('second-reader-guard.mjs', cmd, { session: 'local_a' })
    expect(hook('second-reader-guard.mjs', cmd, { session: 'local_b' }).code).toBe(2)
    for (let i = 0; i < 3; i++) expect(hook('second-reader-guard.mjs', cmd, { session: '' }).code).toBe(2)
    write('.claude/brain.json', brain({ guards: { verified: 'enforce', letThroughAfter: 0 } }))
    for (let i = 0; i < 3; i++) expect(hook('second-reader-guard.mjs', cmd, { session: 'local_c' }).code).toBe(2)
  })

  it('the push guard never lets a push to main through, however often it blocked', () => {
    for (let i = 0; i < 4; i++) expect(hook('main-push-guard.mjs', 'git push origin main').code).toBe(2)
    expect(logLines().every((e) => e.decision === 'blocked' && e.guard === 'mainPush')).toBe(true)
  })

  it('observe and off, once merged: observe logs would-block, off logs nothing; both let the commit through', () => {
    const merge = (guards) => {
      git('stash', '-q')
      write('.claude/brain.json', brain({ guards })); git('add', '.claude/brain.json'); git('commit', '-q', '-m', 'mode', '-m', 'Second-Reader: x')
      git('switch', '-q', 'main'); git('merge', '-q', 'work'); git('switch', '-q', 'work')
      git('stash', 'pop', '-q'); git('add', 'src/billing.ts')
    }
    merge({ secondReader: 'observe' })
    expect(hook('second-reader-guard.mjs', 'git commit -m x').code).toBe(0)
    expect(logLines().pop().decision).toBe('would-block')
    const before = logLines().length
    merge({ secondReader: 'off', verified: 'off' })
    expect(hook('second-reader-guard.mjs', 'git commit -m x').code).toBe(0)
    expect(logLines().length).toBe(before)
  })
})

describe('4. done needs evidence', () => {
  const lanes = path.join(root, 'lanes4')
  const registry = path.join(lanes, 'lanes.json')
  const env = () => { const e = { ...process.env, LANE_REGISTRY: registry }; delete e.CLAUDE_CODE_HOST_SESSION_ID; return e }
  const inbox = (args, text = '') => spawnSync('node', [path.join(SCRIPTS, 'lane-inbox.mjs'), ...args], { input: text, encoding: 'utf8', env: env() })
  const items = () => JSON.parse(readFileSync(path.join(lanes, 'ops.inbox.json'), 'utf8')).items
  beforeEach(() => {
    rmSync(lanes, { recursive: true, force: true })
    mkdirSync(lanes, { recursive: true })
    writeFileSync(registry, JSON.stringify({ lanes: [{ slug: 'ops', name: 'Ops', sessionId: 'local_o', keywords: [] }] }))
  })

  it('refuses done with no evidence, or "none" with no reason, and changes nothing', () => {
    inbox(['add', 'ops', '--id', 'e1'], 'fix the cron')
    const bare = inbox(['done', 'ops', 'e1'])
    expect(bare.status).toBe(1)
    expect(bare.stderr).toContain('--evidence')
    expect(inbox(['done', 'ops', 'e1', '--evidence', 'none']).status).toBe(1)
    expect(inbox(['done', 'ops', 'e1', '--evidence', '  ']).status).toBe(1)
    expect(items()[0].status).toBe('pending')
  })

  it('stores the evidence; the evidence is never read as an id; the report counts the checked ones', () => {
    inbox(['add', 'ops', '--id', 'e1'], 'one')
    inbox(['add', 'ops', '--id', 'e2'], 'two')
    expect(inbox(['done', 'ops', 'e1', '--evidence', 'e2']).stdout).toContain('Marked done: e1.') // "e2" is the evidence
    expect(items().find((i) => i.id === 'e2').status).toBe('pending')
    expect(inbox(['done', 'ops', 'e2', '--evidence', 'none: a question, answered in the lane']).status).toBe(0)
    expect(items().find((i) => i.id === 'e1').evidence).toBe('e2')
    expect(inbox(['list', 'ops', '--all']).stdout).toContain('evidence: none: a question')
    const r = spawnSync('node', [path.join(SCRIPTS, 'lane-report.mjs'), '--json'], { encoding: 'utf8', env: env() })
    const ops = JSON.parse(r.stdout).lanes.find((l) => l.slug === 'ops')
    expect(ops.checked).toBe(1)
    expect(ops.noneEvidence).toBe(1)
  })
})

describe('the lanes skill and the report', () => {
  it('the skill says to stop after three failed fix rounds', () => {
    const skill = readFileSync(path.join(SCRIPTS, '..', 'skills', 'lanes', 'SKILL.md'), 'utf8')
    expect(skill).toContain('three rounds')
  })

  it('lane-report counts the base branch\'s commits by their Verified line, and the guard log', () => {
    project()
    write('src/w.ts', 'w'); git('add', '-A'); git('commit', '-q', '-m', 'on the branch only', '-m', 'Verified: app')
    git('switch', '-q', 'main') // merged work: the report reads the base branch, not the branch it runs on
    for (const [msg, line] of [['a', 'Verified: tests'], ['b', 'Verified: none (docs)'], ['c', ''], ['d', 'Verified: tla, second-reader']]) {
      write(`src/${msg}.ts`, msg); git('add', '-A'); git('commit', '-q', '-m', msg, ...(line ? ['-m', line] : []))
    }
    hook('main-push-guard.mjs', 'git push origin main')
    const lanes = path.join(root, 'lanes-r')
    mkdirSync(lanes, { recursive: true })
    writeFileSync(path.join(lanes, 'lanes.json'), JSON.stringify({ lanes: [] }))
    const e = { ...process.env, CLAUDE_PROJECT_DIR: repo, GUARD_LOG: logFile, LANE_REGISTRY: path.join(lanes, 'lanes.json') }
    delete e.BRAIN_CONFIG
    const j = JSON.parse(spawnSync('node', [path.join(SCRIPTS, 'lane-report.mjs'), '--json'], { encoding: 'utf8', env: e }).stdout)
    expect(j.commits.commits).toBe(5) // base + 4
    expect(j.commits.byKind.tests).toBe(1)
    expect(j.commits.byKind.app).toBe(0)
    expect(j.commits.byKind.none).toBe(1)
    expect(j.commits.byKind.tla).toBe(1)
    expect(j.commits.noLine).toBe(2)
    expect(j.commits.checked).toBe(2)
    expect(j.guards.mainPush.blocked).toBe(1)
  })
})

describe('second read of 0.6.1', () => {
  it('a base with no brain.json has the default rules: a working-tree brain.json cannot turn the gates off', () => {
    repo = path.join(root, `p${++n}`); logFile = path.join(root, `log${n}.jsonl`)
    mkdirSync(repo, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo })
    write('.claude/covered-files.json', JSON.stringify({ billing: ['src/billing.ts'] })) // the default list path
    write('src/billing.ts', '1\n'); git('add', '-A'); git('commit', '-q', '-m', 'base'); git('switch', '-q', '-c', 'work')
    write('.claude/brain.json', JSON.stringify({ guards: { secondReader: 'off', mainPush: 'off' }, secondReader: { coveredFiles: 'none.json' } }))
    write('src/billing.ts', '2\n'); git('add', 'src/billing.ts')
    expect(hook('second-reader-guard.mjs', 'git commit -m x').code).toBe(2)
    expect(hook('main-push-guard.mjs', 'git push origin main').code).toBe(2)
  })

  it('a rename is its old path too: moving the list or a covered file away needs the read', () => {
    project()
    git('mv', 'checks/covered.json', 'checks/old.json')
    expect(hook('second-reader-guard.mjs', 'git commit -m x', { session: 'local_r1' }).err).toContain('guard rules: checks/covered.json')
    git('reset', '-q', '--hard')
    git('mv', 'src/billing.ts', 'src/b2.ts')
    expect(hook('second-reader-guard.mjs', 'git commit -m x', { session: 'local_r2' }).err).toContain('billing: src/billing.ts')
  })

  it('an old Second-Reader line does not cover new files: --amend --no-edit, -C, and "-C" inside a message', () => {
    project()
    write('src/billing.ts', '2\n'); git('add', 'src/billing.ts'); git('commit', '-q', '-m', 'one', '-m', 'Second-Reader: fresh agent')
    write('src/billing.ts', '3\n'); git('add', 'src/billing.ts')
    let k = 0
    for (const cmd of ['git commit --amend --no-edit', 'git commit -C HEAD', 'git commit -m "see -C HEAD"']) {
      expect(hook('second-reader-guard.mjs', cmd, { session: `local_m${++k}` }).code).toBe(2)
    }
  })

  it('the let-through needs blocks IN A ROW: a commit the gate passed starts the count again', () => {
    project(brain())
    write('src/billing.ts', '2\n'); git('add', 'src/billing.ts')
    expect(hook('second-reader-guard.mjs', 'git commit -m x').code).toBe(2)
    expect(hook('second-reader-guard.mjs', 'git commit -m x').code).toBe(2)
    expect(hook('second-reader-guard.mjs', 'git commit -m x -m "Second-Reader: fresh agent"').code).toBe(0)
    expect(hook('second-reader-guard.mjs', 'git commit -m x').code).toBe(2) // not let through: the run was broken
    expect(logLines().map((e) => e.decision).join(',')).toBe('blocked,blocked,passed,blocked')
  })

  it('blocks older than an hour do not count toward the let-through', () => {
    project(brain())
    write('src/billing.ts', '2\n'); git('add', 'src/billing.ts')
    const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    writeFileSync(logFile, [1, 2].map(() => JSON.stringify({ at: old, guard: 'secondReader', mode: 'enforce', decision: 'blocked', session: 'local_s1', reason: 'x' })).join('\n') + '\n')
    expect(hook('second-reader-guard.mjs', 'git commit -m x').code).toBe(2)
  })

  it('with an origin, the base is origin\'s branch: not a moved local main, not an origin HEAD pointed at a local branch', () => {
    project()
    const remote = path.join(root, `remote${n}.git`)
    execFileSync('git', ['clone', '-q', '--bare', repo, remote])
    git('remote', 'add', 'origin', remote); git('fetch', '-q', 'origin')
    write('.claude/brain.json', brain({ guards: { secondReader: 'off' } })); git('add', '.claude/brain.json')
    git('commit', '-q', '-m', 'off', '-m', 'Second-Reader: x'); git('branch', '-f', 'main', 'work')
    git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/work') // origin HEAD moved outside refs/remotes/origin/
    write('src/billing.ts', '2\n'); git('add', 'src/billing.ts')
    expect(hook('second-reader-guard.mjs', 'git commit -m x').code).toBe(2)
  })

  it('a kind added in the working tree is not accepted until it is merged', () => {
    project(brain({ guards: { verified: 'enforce' } }))
    write('.claude/brain.json', brain({ guards: { verified: 'enforce' }, verified: { kinds: ['vibes'] } }))
    expect(hook('verified-guard.mjs', 'git commit -m x -m "Verified: vibes"').code).toBe(2)
  })

  it('--evidence=<text> works, and --evidence twice is refused', () => {
    const lanes = path.join(root, 'lanes9')
    mkdirSync(lanes, { recursive: true })
    const reg = path.join(lanes, 'lanes.json')
    writeFileSync(reg, JSON.stringify({ lanes: [{ slug: 'ops', name: 'Ops', sessionId: null, keywords: [] }] }))
    const e = { ...process.env, LANE_REGISTRY: reg }; delete e.CLAUDE_CODE_HOST_SESSION_ID
    const run = (args, text = '') => spawnSync('node', [path.join(SCRIPTS, 'lane-inbox.mjs'), ...args], { input: text, encoding: 'utf8', env: e })
    run(['add', 'ops', '--id', 'q1'], 'one')
    expect(run(['done', 'ops', 'q1', '--evidence', 'a', '--evidence', 'b']).status).toBe(1)
    expect(run(['done', 'ops', 'q1', '--evidence=None of the 12 tests failed']).status).toBe(0)
    const r = JSON.parse(spawnSync('node', [path.join(SCRIPTS, 'lane-report.mjs'), '--json'], { encoding: 'utf8', env: e }).stdout)
    expect(r.lanes[0].checked).toBe(1) // "None of the tests failed" is evidence, not "none"
  })

  it('a branch the working tree names cannot be the only base: a decoy origin branch with loose rules changes nothing', () => {
    project()
    const remote = path.join(root, `remote${n}.git`)
    execFileSync('git', ['clone', '-q', '--bare', repo, remote])
    git('remote', 'add', 'origin', remote); git('fetch', '-q', 'origin')
    const decoy = brain({ protectedBranch: 'decoy', guards: { secondReader: 'off', mainPush: 'off', verified: 'off' }, secondReader: { coveredFiles: 'none.json' } })
    write('.claude/brain.json', decoy); git('add', '.claude/brain.json'); git('commit', '-q', '-m', 'decoy', '-m', 'Second-Reader: x')
    git('update-ref', 'refs/remotes/origin/decoy', 'HEAD')
    write('src/billing.ts', '2\n'); git('add', 'src/billing.ts')
    expect(hook('second-reader-guard.mjs', 'git commit -m x', { session: 'local_d1' }).code).toBe(2)
    expect(hook('main-push-guard.mjs', 'git push origin HEAD:main', { session: 'local_d2' }).code).toBe(2)
  })

  it('the Verified gate reads real commits only, not "git commit" in a PR body or a heredoc', () => {
    project(brain({ guards: { verified: 'enforce' } }))
    expect(hook('verified-guard.mjs', 'gh pr create --body "Adds a check before every git commit in a lane"', { session: 'local_q1' }).code).toBe(0)
    expect(hook('verified-guard.mjs', 'cat > notes.md <<EOF\nthen git commit -m x\nEOF', { session: 'local_q2' }).code).toBe(0)
    expect(hook('verified-guard.mjs', 'git -C "' + repo + '" commit -m x', { session: 'local_q3' }).code).toBe(2)
  })

  it('a project in a subfolder of the repository: its rule files are still rule files', () => {
    project()
    const sub = path.join(repo, 'app')
    mkdirSync(path.join(sub, '.claude'), { recursive: true })
    mkdirSync(path.join(sub, 'checks'), { recursive: true })
    writeFileSync(path.join(sub, 'checks/covered.json'), JSON.stringify({ billing: ['src/billing.ts'] })) // the project's own list
    writeFileSync(path.join(sub, '.claude/brain.json'), brain({ owner: 'Bob' }))
    git('add', 'app/.claude/brain.json')
    const r = spawnSync('node', [path.join(SCRIPTS, 'second-reader-guard.mjs')], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, cwd: repo, session_id: 'local_sub' }),
      encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: sub, GUARD_LOG: logFile, BRAIN_CONFIG: '' },
    })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('guard rules: app/.claude/brain.json')
  })

  it('"none." or "none!" is refused as evidence; "none - docs" is none; the report agrees with done', () => {
    const lanes = path.join(root, 'lanes10')
    mkdirSync(lanes, { recursive: true })
    const reg = path.join(lanes, 'lanes.json')
    writeFileSync(reg, JSON.stringify({ lanes: [{ slug: 'ops', name: 'Ops', sessionId: null, keywords: [] }] }))
    const e = { ...process.env, LANE_REGISTRY: reg }; delete e.CLAUDE_CODE_HOST_SESSION_ID
    const run = (args, text = '') => spawnSync('node', [path.join(SCRIPTS, 'lane-inbox.mjs'), ...args], { input: text, encoding: 'utf8', env: e })
    run(['add', 'ops', '--id', 'z1'], 'one')
    for (const bad of ['none.', 'none,', 'none!', 'none:', 'NONE']) expect(run(['done', 'ops', 'z1', '--evidence', bad]).status).toBe(1)
    expect(run(['done', 'ops', 'z1', '--evidence', 'none - docs only']).status).toBe(0)
    const r = JSON.parse(spawnSync('node', [path.join(SCRIPTS, 'lane-report.mjs'), '--json'], { encoding: 'utf8', env: e }).stdout)
    expect(r.lanes[0].checked).toBe(0)
    expect(r.lanes[0].noneEvidence).toBe(1)
  })
})
