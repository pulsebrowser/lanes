import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectStateFile } from '../scripts/state-file.mjs'

/**
 * State files stay small (0.3.0): state-file.mjs names old Done items and a file over the cap; the lane guard
 * turns that into a trim note on `lane: <slug>`; the status line flags a file over the cap.
 */
const NOW = Date.now() // the guard and the status line use the real clock, so the fixture dates are relative to it
const ago = (days) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
let dir = ''
let registry = ''

const stateFile = (slug, done, extraLines = 0) => {
  const f = path.join(dir, `${slug}.md`)
  writeFileSync(f, [
    `# Lane: ${slug}`, '', `Last updated: ${ago(2)} 09:00 JST`, '',
    '## Now', '- the release', '',
    '## Decisions to keep', '- 2026-01-01: an old decision stays, Done rules do not touch it', '',
    '## Done this week', ...done, '',
    '## Where things are', ...Array.from({ length: extraLines }, (_, i) => `- line ${i}`),
  ].join('\n') + '\n')
  return f
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lane-state-'))
  registry = path.join(dir, 'lanes.json')
  writeFileSync(registry, JSON.stringify({ lanes: [
    { slug: 'ops', name: 'Ops', sessionId: 'local_ops', keywords: ['deploy'] },
    { slug: 'big', name: 'Big', sessionId: 'local_big', keywords: ['huge'] },
  ] }))
  stateFile('ops', [`- ${ago(1)}: shipped the fix (#12)`, `- ${ago(11)}: an old item (#9)`, `- ${ago(23)}: older (#4)`])
  stateFile('big', [`- ${ago(1)}: fresh`], 200)
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('state file check', () => {
  it('names Done items older than doneDays, and only Done items', () => {
    const r = inspectStateFile(path.join(dir, 'ops.md'), {}, NOW)
    expect(r.staleDone.length).toBe(2)
    expect(r.staleDone.join('\n')).toContain('an old item')
    expect(r.staleDone.join('\n')).not.toContain('shipped the fix')
    expect(r.staleDone.join('\n')).not.toContain('old decision')
    expect(r.overCap).toBe(false)
    expect(r.daysSinceUpdate).toBe(2)
  })

  it('takes its limits from the config', () => {
    expect(inspectStateFile(path.join(dir, 'ops.md'), { doneDays: 30 }, NOW).staleDone.length).toBe(0)
    expect(inspectStateFile(path.join(dir, 'ops.md'), { maxLines: 5 }, NOW).overCap).toBe(true)
  })

  it('flags a file over the cap and returns null for a missing file', () => {
    const r = inspectStateFile(path.join(dir, 'big.md'), {}, NOW)
    expect(r.overCap).toBe(true)
    expect(r.maxLines).toBe(150)
    expect(inspectStateFile(path.join(dir, 'missing.md'))).toBe(null)
  })
})

describe('trim on clear (lane guard)', () => {
  const guard = (prompt) => spawnSync('node', [path.join(process.cwd(), 'scripts/lane-guard.mjs')], {
    input: JSON.stringify({ prompt, session_id: 'x' }), encoding: 'utf8', env: { ...process.env, LANE_REGISTRY: registry },
  })

  it('tells the model to trim and rewrite, and names the old Done items', () => {
    const r = guard('lane: ops')
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('REWRITE it (never append)')
    expect(r.stdout).toContain('older than 7 days')
    expect(r.stdout).toContain('an old item (#9)')
    expect(r.stdout).not.toContain('shipped the fix')
    expect(r.stdout).not.toContain('over the cap')
  })

  it('says when the file is over the cap', () => {
    expect(guard('lane: big').stdout).toContain('over the cap of 150')
  })
})

describe('status line flag', () => {
  const sl = (session) => spawnSync('node', [path.join(process.cwd(), 'scripts/statusline.mjs')], {
    input: JSON.stringify({ session_id: session }), encoding: 'utf8', env: { ...process.env, LANE_REGISTRY: registry },
  }).stdout.trim()

  it('adds the line count only when the file is over the cap', () => {
    expect(sl('local_ops')).toBe('lane: Ops')
    expect(sl('local_big')).toContain('lane: Big, state file 2')
  })
})
