import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The lane status line (scripts/statusline.mjs): prints the lane a session is, by its id in lanes.json or by its
 * first typed message (`lane: <slug>`, `new: lane <slug>`). Prints nothing for any other session.
 */
const SCRIPT = path.join(process.cwd(), 'scripts/statusline.mjs')
let dir = ''
let registry = ''

const transcript = (...prompts) => {
  const f = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
  const lines = [
    JSON.stringify({ type: 'user', isMeta: true, message: { content: '<command-name>/clear</command-name>' } }),
    ...prompts.map((p) => JSON.stringify({ type: 'user', message: { content: p } })),
  ]
  writeFileSync(f, lines.join('\n') + '\n')
  return f
}

const run = (input, env = {}) => {
  const e = { ...process.env, LANE_REGISTRY: registry, ...env }
  if (!env.CLAUDE_CODE_HOST_SESSION_ID) delete e.CLAUDE_CODE_HOST_SESSION_ID
  const r = spawnSync('node', [SCRIPT], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: e })
  expect(r.status).toBe(0)
  return r.stdout.trim()
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lane-sl-'))
  registry = path.join(dir, 'lanes.json')
  writeFileSync(registry, JSON.stringify({ lanes: [
    { slug: 'sites', name: 'Sites', sessionId: 'local_sites-1' },
    { slug: 'brain-ci', name: 'Brain and CI', sessionId: 'cli-uuid-2' },
    { slug: 'ops', name: 'Ops', sessionId: null },
  ] }))
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('lane status line', () => {
  it('names the lane from the desktop app id', () => {
    expect(run({ session_id: 'x' }, { CLAUDE_CODE_HOST_SESSION_ID: 'local_sites-1' })).toBe('lane: Sites')
  })

  it('names the lane from the session_id on stdin', () => {
    expect(run({ session_id: 'cli-uuid-2' })).toBe('lane: Brain and CI')
  })

  it('names the lane from the first typed message, after a clear', () => {
    expect(run({ session_id: 'new', transcript_path: transcript('lane: ops', 'deploy it') })).toBe('lane: Ops')
    expect(run({ session_id: 'new', transcript_path: transcript('new: lane ops') })).toBe('lane: Ops')
    expect(run({ session_id: 'new', transcript_path: transcript('Lane:  Brain-CI please') })).toBe('lane: Brain and CI')
  })

  it('reads only the FIRST typed message', () => {
    expect(run({ session_id: 'new', transcript_path: transcript('fix the footer', 'lane: ops') })).toBe('')
  })

  it('prints nothing for a session that is not a lane', () => {
    expect(run({ session_id: 'other', transcript_path: transcript('lane: nope') })).toBe('')
    expect(run({ session_id: 'other' })).toBe('')
  })

  it('takes a format', () => {
    expect(run({ session_id: 'cli-uuid-2' }, { LANES_STATUSLINE_FORMAT: '[{slug}]' })).toBe('[brain-ci]')
  })

  it('fails quiet on bad input or a missing registry', () => {
    expect(run('not json')).toBe('')
    expect(run({ session_id: 'cli-uuid-2' }, { LANE_REGISTRY: path.join(dir, 'missing.json') })).toBe('')
  })
})
