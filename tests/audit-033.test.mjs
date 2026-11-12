import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Regression tests for the 0.3.3 audit (2026-11-12): each case was a reproduced finding of an outside review.
 * Exit 2 = stopped. Exit 0 = goes through.
 */
const SCRIPT = (n) => path.join(process.cwd(), 'scripts', n)
const tmp = mkdtempSync(path.join(os.tmpdir(), 'lanes-audit-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const hook = (name, input, env = {}) => {
  const e = { ...process.env, ...env }
  if (!env.CLAUDE_CODE_HOST_SESSION_ID) delete e.CLAUDE_CODE_HOST_SESSION_ID
  return spawnSync('node', [SCRIPT(name)], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: e })
}
const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd })

describe('lane: picks the right lane', () => {
  const registry = path.join(tmp, 'match', 'lanes.json')
  const write = (lanes) => { mkdirSync(path.dirname(registry), { recursive: true }); writeFileSync(registry, JSON.stringify({ lanes })) }
  const ids = () => Object.fromEntries(JSON.parse(readFileSync(registry, 'utf8')).lanes.map((l) => [l.slug, l.sessionId]))
  const claim = (prompt, me) => hook('lane-guard.mjs', { prompt, session_id: 'x' }, { LANE_REGISTRY: registry, CLAUDE_CODE_HOST_SESSION_ID: me })

  it('the longest match wins: lane: web-api is not the lane web', () => {
    write([{ slug: 'web', name: 'Web', sessionId: 'local_web' }, { slug: 'web-api', name: 'Web API', sessionId: 'local_api' }])
    const r = claim('lane: web-api, continue', 'local_new')
    expect(r.stdout).toContain('"Web API" lane')
    expect(ids().web).toBe('local_web')
    expect(ids()['web-api']).toBe('local_new')
  })

  it('a lane with an empty name or an unsafe slug matches nothing', () => {
    write([{ slug: 'x', name: '', sessionId: null }, { slug: '../etc', name: 'Etc', sessionId: null }, { slug: 'sites', name: 'Sites', sessionId: null }])
    expect(claim('lane: sites', 'local_s').stdout).toContain('"Sites" lane')
    expect(claim('lane: etc', 'local_e').stdout).toBe('')
    expect(ids().x).toBe(null)
  })

  it('two sessions claiming at the same moment both keep their claim', async () => {
    for (let round = 0; round < 5; round++) {
      write([{ slug: 'a', name: 'A', sessionId: 'old' }, { slug: 'b', name: 'B', sessionId: 'old' }])
      const go = (prompt, me) => new Promise((resolve) => {
        const env = { ...process.env, LANE_REGISTRY: registry, CLAUDE_CODE_HOST_SESSION_ID: me }
        const p = spawn('node', [SCRIPT('lane-guard.mjs')], { env })
        p.on('close', resolve)
        p.stdin.end(JSON.stringify({ prompt, session_id: 'x' }))
      })
      await Promise.all([go('lane: a', 'local_a'), go('lane: b', 'local_b')])
      expect(ids().a).toBe('local_a')
      expect(ids().b).toBe('local_b')
    }
  })
})

describe('lane guard: first prompt and scheduled tasks', () => {
  const dir = path.join(tmp, 'first')
  const registry = path.join(dir, 'lanes.json')
  const tasks = path.join(dir, 'tasks')
  beforeAll(() => {
    mkdirSync(path.join(tasks, 'ship'), { recursive: true })
    writeFileSync(registry, JSON.stringify({ lanes: [{ slug: 'ops', name: 'Ops', sessionId: 'local_ops', keywords: ['deploy'] }] }))
    writeFileSync(path.join(tasks, 'ship', 'SKILL.md'), '---\nname: ship\n---\n\nEvery Monday, deploy the staging build and report what changed since last week.\n')
  })
  const transcript = (...texts) => {
    const f = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(f, texts.map((t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } })).join('\n') + '\n')
    return f
  }
  const run = (prompt, t) => hook('lane-guard.mjs', { prompt, session_id: 'x', transcript_path: t }, { LANE_REGISTRY: registry, LANE_TASKS_DIR: tasks })

  it('the same words sent twice in a session are not a first prompt', () => {
    expect(run('deploy it', transcript('deploy it', 'deploy it')).status).toBe(0)
  })

  it('a pasted message that starts with < still counts as typed', () => {
    expect(run('now deploy the fix', transcript('<div>broken</div> look at this', 'now deploy the fix')).status).toBe(0)
  })

  it('the current prompt alone in the transcript is still a first prompt', () => {
    expect(run('please deploy the fix', transcript('please deploy the fix')).status).toBe(2)
  })

  it('a short prompt is not a scheduled task because a task uses the same word', () => {
    expect(run('deploy').status).toBe(2)
  })

  it('a scheduled task run still passes', () => {
    expect(run('Every Monday, deploy the staging build and report what changed since last week.').status).toBe(0)
  })
})

describe('a brain.json value of the wrong type never breaks a hook', () => {
  const bad = path.join(tmp, 'bad-brain.json')
  writeFileSync(bad, JSON.stringify({ owner: 3, scheduledTasksDir: null, lanesDir: ['x'], stateFile: 'big', secondReader: 7 }))
  for (const [name, input] of [
    ['lane-guard.mjs', { prompt: 'hello', session_id: 'x' }],
    ['main-push-guard.mjs', bash('ls')],
    ['second-reader-guard.mjs', bash('git commit -m x')],
    ['lane-pr-guard.mjs', bash('gh pr create')],
  ]) {
    it(`${name} exits 0 with no error`, () => {
      const r = hook(name, input, { BRAIN_CONFIG: bad, LANE_REGISTRY: '' })
      expect(r.status).toBe(0)
      expect(r.stderr).toBe('')
    })
  }
})

describe('push guard: more ways to push main', () => {
  const repo = path.join(tmp, 'push')
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
  beforeAll(() => {
    mkdirSync(repo, { recursive: true })
    git('init', '-q', '-b', 'main')
    writeFileSync(path.join(repo, 'a'), 'a')
    git('add', 'a'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a')
  })
  const run = (c) => hook('main-push-guard.mjs', bash(c, repo)).status

  it('stops --all, --mirror, git options and a full git path, on any branch', () => {
    git('switch', '-q', '-c', 'feat/z')
    for (const c of ['git push --all origin', 'git push --mirror origin', 'git --no-pager push origin main',
      'git --git-dir=.git push origin main', '/usr/bin/git push origin main']) expect(run(c), c).toBe(2)
    expect(run('git push origin feat/z')).toBe(0)
    git('switch', '-q', 'main')
  })

  it('stops git push origin @ on main', () => {
    expect(run('git push origin @')).toBe(2)
  })
})

describe('second reader: every path a commit can take', () => {
  const repo = path.join(tmp, 'reader')
  const git = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'ignore' })
  const covered = path.join(tmp, 'covered.json')
  const cfg = path.join(tmp, 'reader-brain.json')
  beforeAll(() => {
    mkdirSync(path.join(repo, 'lib'), { recursive: true })
    git('init', '-q')
    writeFileSync(path.join(repo, 'lib/billing.ts'), 'a\n')
    writeFileSync(path.join(repo, 'lib/other.ts'), 'a\n')
    git('add', '.'); git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a')
    writeFileSync(path.join(repo, 'lib/billing.ts'), 'changed\n') // an UNSTAGED change to a covered file
    writeFileSync(covered, JSON.stringify({ billing: ['lib/billing.ts'] }))
    writeFileSync(cfg, JSON.stringify({ secondReader: { coveredFiles: covered } }))
  })
  const run = (c) => hook('second-reader-guard.mjs', bash(c, repo), { BRAIN_CONFIG: cfg }).status

  it('stops a covered file reached through a pathspec, a folder, a glob or a cd', () => {
    for (const c of ['git commit lib/billing.ts -m x', 'git commit -m x -- lib/billing.ts', 'git add lib && git commit -m x',
      'git add "lib/*.ts" && git commit -m x', 'cd lib && git add billing.ts && git commit -m x', 'git --no-pager commit -am x'])
      expect(run(c), c).toBe(2)
  })

  it('lets an unrelated commit through', () => {
    expect(run('git add lib/other.ts && git commit -m x')).toBe(0)
  })

  it('a trailer must be in the commit itself, not elsewhere in the command', () => {
    expect(run(`echo 'Second-Reader: nope'; git commit -am x`)).toBe(2)
    expect(run('git commit -am "x" -m "Second-Reader: fresh agent, no findings"')).toBe(0)
  })

  it('reads the trailer from -Ffile and from an escaped newline', () => {
    const msg = path.join(repo, 'msg.txt')
    writeFileSync(msg, 'fix\n\nSecond-Reader: fresh agent\n')
    expect(run(`git commit -a -F${msg}`)).toBe(0)
    expect(run(`git commit -a -m "$(printf 'fix\\n\\nSecond-Reader: fresh agent')"`)).toBe(0)
  })

  it('checks every commit in a chain', () => {
    expect(run('git commit --allow-empty -m "Second-Reader: n/a" && git commit -am x')).toBe(2)
  })
})

describe('lane PR guard: gh with options', () => {
  const registry = path.join(tmp, 'pr', 'lanes.json')
  mkdirSync(path.dirname(registry), { recursive: true })
  writeFileSync(registry, JSON.stringify({ lanes: [{ slug: 'ops', name: 'Ops', sessionId: 'local_ops' }] }))
  it('stops gh -R, gh --repo= and a full gh path', () => {
    for (const c of ['gh -R o/r pr create', 'gh --repo=o/r pr new', '/opt/homebrew/bin/gh pr create'])
      expect(hook('lane-pr-guard.mjs', bash(c), { LANE_REGISTRY: registry, CLAUDE_CODE_HOST_SESSION_ID: 'local_ops' }).status, c).toBe(2)
  })
})

describe('status line text', () => {
  it('prints a $& in a lane name as text', () => {
    const registry = path.join(tmp, 'sl', 'lanes.json')
    mkdirSync(path.dirname(registry), { recursive: true })
    writeFileSync(registry, JSON.stringify({ lanes: [{ slug: 'rd', name: 'R$&D', sessionId: 'sid' }] }))
    expect(hook('statusline.mjs', { session_id: 'sid' }, { LANE_REGISTRY: registry }).stdout.trim()).toBe('lane: R$&D')
  })
})
