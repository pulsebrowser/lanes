import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The conductor (0.4.0): scripts/conductor-lanes.mjs prints the routing table, and the lane guard never stops the
 * conductor's own messages, points stopped sessions to it, and tells `lane: conductor` to follow its skill.
 */
const SCRIPT = (n) => path.join(process.cwd(), 'scripts', n)
let dir = ''
let registry = ''
const lanes = [
  { slug: 'conductor', name: 'Conductor', title: 'Conductor', role: 'conductor', sessionId: 'local_cond', keywords: [] },
  { slug: 'ops', name: 'Ops', title: 'Ops', sessionId: 'local_ops', description: 'Deploys and servers.', keywords: ['deploy', 'nginx'] },
  { slug: 'web', name: 'Web', title: 'Web', sessionId: null, description: 'The marketing site.', keywords: ['landing'] },
  { slug: '../evil', name: 'Evil', sessionId: 'local_x', description: 'unsafe slug' },
]
const run = (name, input, env = {}) => {
  const e = { ...process.env, LANE_REGISTRY: registry, ...env }
  if (!env.CLAUDE_CODE_HOST_SESSION_ID) delete e.CLAUDE_CODE_HOST_SESSION_ID
  return spawnSync('node', [SCRIPT(name)], { input: input ? JSON.stringify(input) : '', encoding: 'utf8', env: e })
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lanes-conductor-'))
  registry = path.join(dir, 'lanes.json')
  writeFileSync(registry, JSON.stringify({ lanes }))
  writeFileSync(path.join(dir, 'ops.md'), '# Lane: Ops\n\n## Now\n- moving the cron to the new box\n- nginx reload pending\n- third\n- fourth\n\n## Done this week\n- 2026-11-01: old\n')
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('routing table', () => {
  it('lists each work lane with what it does, its session and what it is doing now', () => {
    const out = run('conductor-lanes.mjs').stdout
    expect(out).toContain('## ops: Ops')
    expect(out).toContain('- does: Deploys and servers.')
    expect(out).toContain('- session: local_ops')
    expect(out).toContain('- now: moving the cron to the new box | nginx reload pending | third')
    expect(out).not.toContain('fourth') // only the first three Now lines
    expect(out).not.toContain('2026-11-01') // never the Done section
    expect(out).toContain('no session yet (the owner must start it with "lane: web")')
  })

  it('lists the conductor apart, and skips unsafe slugs', () => {
    const out = run('conductor-lanes.mjs').stdout
    expect(out).not.toContain('## conductor')
    expect(out).toContain('Conductor: Conductor, session local_cond.')
    expect(out).not.toContain('evil')
  })

  it('fails quiet with no registry', () => {
    const r = run('conductor-lanes.mjs', null, { LANE_REGISTRY: path.join(dir, 'none.json') })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('No lanes registry')
  })
})

describe('lane guard with a conductor', () => {
  it('never stops the conductor session, even on its first message', () => {
    expect(run('lane-guard.mjs', { prompt: 'please deploy the nginx change', session_id: 'x' }, { CLAUDE_CODE_HOST_SESSION_ID: 'local_cond' }).status).toBe(0)
  })

  it('points a stopped new session to the conductor', () => {
    const r = run('lane-guard.mjs', { prompt: 'please deploy the nginx change', session_id: 'x' })
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Or send it to the conductor ("Conductor")')
  })

  it('never routes TO the conductor by keywords', () => {
    writeFileSync(registry, JSON.stringify({ lanes: [{ ...lanes[0], keywords: ['deploy'] }, ...lanes.slice(1)] }))
    const r = run('lane-guard.mjs', { prompt: 'please deploy the nginx change', session_id: 'x' })
    expect(r.stderr).toContain('looks like Ops work')
    writeFileSync(registry, JSON.stringify({ lanes }))
  })

  it('tells lane: conductor to follow the conductor skill, and a work lane not', () => {
    expect(run('lane-guard.mjs', { prompt: 'lane: conductor', session_id: 'x' }).stdout).toContain('follow the lanes:conductor skill')
    expect(run('lane-guard.mjs', { prompt: 'lane: ops', session_id: 'x' }).stdout).not.toContain('CONDUCTOR')
    expect(JSON.parse(readFileSync(registry, 'utf8')).lanes[0].sessionId).toBe('local_cond') // no app id: no claim
  })
})
