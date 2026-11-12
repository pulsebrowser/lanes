import { describe, it, beforeEach, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The lane claim (0.3.2): `lane: <slug>` in the desktop app writes this session's id into lanes.json, and the guard
 * tells the model to turn off the session's auto_archive_on_close switch. Outside the app (no
 * CLAUDE_CODE_HOST_SESSION_ID) nothing is written and no switch is mentioned.
 */
const HOOK = path.join(process.cwd(), 'scripts/lane-guard.mjs')
const dir = mkdtempSync(path.join(os.tmpdir(), 'lane-claim-'))
const registry = path.join(dir, 'lanes.json')
const ids = () => Object.fromEntries(JSON.parse(readFileSync(registry, 'utf8')).lanes.map((l) => [l.slug, l.sessionId]))

const run = (prompt, me) => {
  const env = { ...process.env, LANE_REGISTRY: registry }
  delete env.CLAUDE_CODE_HOST_SESSION_ID
  if (me) env.CLAUDE_CODE_HOST_SESSION_ID = me
  return spawnSync('node', [HOOK], { input: JSON.stringify({ prompt, session_id: 'x' }), encoding: 'utf8', env })
}

beforeEach(() => {
  writeFileSync(registry, JSON.stringify({ lanes: [
    { slug: 'sites', name: 'Sites', sessionId: 'local_old', keywords: ['run'] },
    { slug: 'ops', name: 'Ops', sessionId: null, keywords: ['deploy'] },
  ] }))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('lane claim', () => {
  it('writes this session into lanes.json and says what it replaced', () => {
    const r = run('lane: sites', 'local_new')
    expect(r.status).toBe(0)
    expect(ids().sites).toBe('local_new')
    expect(ids().ops).toBe(null) // other lanes untouched
    expect(r.stdout).toContain('now names this session (local_new)')
    expect(r.stdout).toContain('it named local_old before')
  })

  it('claims a lane that had no session', () => {
    expect(run('lane: ops', 'local_ops').stdout).toContain('it named none before')
    expect(ids().ops).toBe('local_ops')
  })

  it('writes nothing and says nothing when the session already is the lane', () => {
    const r = run('lane: sites', 'local_old')
    expect(ids().sites).toBe('local_old')
    expect(r.stdout).not.toContain('now names this session')
  })

  it('tells the model to turn off the archive switch, in the app only', () => {
    expect(run('lane: sites', 'local_old').stdout).toContain('"auto_archive_on_close": false')
    const cli = run('lane: sites')
    expect(cli.stdout).not.toContain('auto_archive_on_close')
    expect(ids().sites).toBe('local_old') // no app id: no claim
  })

  it('leaves no temporary file behind', () => {
    run('lane: sites', 'local_new')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp')).length).toBe(0)
  })

  it('does not claim on an ordinary first message', () => {
    run('please deploy the fix', 'local_x')
    expect(ids().ops).toBe(null)
  })
})
