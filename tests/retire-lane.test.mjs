import { describe, it, beforeEach, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Retiring a lane (scripts/retire-lane.mjs, 0.4.1): marked, never deleted; skipped by the guard, the conductor and the status line. */
const SCRIPT = (n) => path.join(process.cwd(), 'scripts', n)
const dir = mkdtempSync(path.join(os.tmpdir(), 'lanes-retire-'))
const registry = path.join(dir, 'lanes.json')
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const run = (name, args = [], input = null, env = {}) => {
  const e = { ...process.env, LANE_REGISTRY: registry, ...env }
  if (!env.CLAUDE_CODE_HOST_SESSION_ID) delete e.CLAUDE_CODE_HOST_SESSION_ID
  return spawnSync('node', [SCRIPT(name), ...args], { input: input ? JSON.stringify(input) : '', encoding: 'utf8', env: e })
}
const entry = (slug) => JSON.parse(readFileSync(registry, 'utf8')).lanes.find((l) => l.slug === slug)

beforeEach(() => {
  rmSync(path.join(dir, 'retired'), { recursive: true, force: true })
  writeFileSync(registry, JSON.stringify({ lanes: [
    { slug: 'conductor', name: 'Conductor', role: 'conductor', sessionId: 'local_c', keywords: [] },
    { slug: 'web', name: 'Web', sessionId: 'local_w', description: 'The website.', keywords: ['homepage', 'seo'] },
    { slug: 'ops', name: 'Ops', sessionId: 'local_o', description: 'Servers.', keywords: ['nginx'] },
  ] }))
  writeFileSync(path.join(dir, 'web.md'), '# Lane: Web\n\n## Now\n- the homepage\n')
})

describe('retire a lane', () => {
  it('marks the entry, clears its session, moves the state file, and names the session to archive', () => {
    const r = run('retire-lane.mjs', ['web'])
    expect(r.status).toBe(0)
    expect(entry('web').retired.length).toBe(10)
    expect(entry('web').sessionId).toBe(null)
    expect(existsSync(path.join(dir, 'web.md'))).toBe(false)
    expect(existsSync(path.join(dir, 'retired', 'web.md'))).toBe(true)
    expect(r.stdout).toContain('Its session (local_w) is not archived by this script')
  })

  it('after it, the guard never sends a new session to the lane, and lane: does not claim it', () => {
    run('retire-lane.mjs', ['web'])
    expect(run('lane-guard.mjs', [], { prompt: 'fix the homepage seo', session_id: 'x' }).status).toBe(0)
    const r = run('lane-guard.mjs', [], { prompt: 'lane: web', session_id: 'x' }, { CLAUDE_CODE_HOST_SESSION_ID: 'local_new' })
    expect(r.stdout).toContain('was retired on')
    expect(entry('web').sessionId).toBe(null)
  })

  it('the conductor table lists it as retired, never as a lane', () => {
    run('retire-lane.mjs', ['web'])
    const out = run('conductor-lanes.mjs').stdout
    expect(out).not.toContain('## web')
    expect(out).toContain('Retired (route nothing there): Web.')
  })

  it('--undo brings it back, state file included', () => {
    run('retire-lane.mjs', ['web'])
    const r = run('retire-lane.mjs', ['web', '--undo'])
    expect(r.status).toBe(0)
    expect(entry('web').retired).toBe(undefined)
    expect(existsSync(path.join(dir, 'web.md'))).toBe(true)
    expect(run('lane-guard.mjs', [], { prompt: 'lane: web', session_id: 'x' }).stdout).toContain('"Web" lane')
  })

  it('refuses an unknown or unsafe slug, and retiring twice', () => {
    expect(run('retire-lane.mjs', ['nope']).status).toBe(1)
    expect(run('retire-lane.mjs', ['../x']).status).toBe(1)
    run('retire-lane.mjs', ['web'])
    expect(run('retire-lane.mjs', ['web']).stderr).toContain('already retired')
    expect(existsSync(registry + '.lock')).toBe(false) // a refusal releases the lock
  })

  it('other lanes keep working', () => {
    run('retire-lane.mjs', ['web'])
    expect(run('lane-guard.mjs', [], { prompt: 'fix the nginx config', session_id: 'x' }).status).toBe(2)
  })
})
