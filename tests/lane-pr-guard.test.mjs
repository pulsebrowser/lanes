import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The lane PR guard (scripts/lane-pr-guard.mjs, 2026-11-11): a lane session must not own a pull request,
 * because the app archives a session when its PR closes. `gh pr create` is stopped only in a session whose app id
 * (CLAUDE_CODE_HOST_SESSION_ID) is a lane's sessionId. Exit 2 = stopped. Exit 0 = the command goes through.
 */
const HOOK = path.join(process.cwd(), 'scripts/lane-pr-guard.mjs')
const LANE = 'local_lane-0000'
let dir = ''
let registry = ''
const run = (command, session = LANE, tool = 'Bash', reg = registry) => {
  const env = { ...process.env, LANE_REGISTRY: reg }
  delete env.CLAUDE_CODE_HOST_SESSION_ID
  if (session) env.CLAUDE_CODE_HOST_SESSION_ID = session
  return spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { command } }), encoding: 'utf8', env })
}

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lane-pr-'))
  registry = path.join(dir, 'lanes.json')
  writeFileSync(registry, JSON.stringify({ lanes: [{ slug: 'sites', name: 'Sites', sessionId: LANE }, { slug: 'ops', name: 'Ops', sessionId: null }] }))
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('lane PR guard', () => {
  it('stops a PR opened from a lane session', () => {
    for (const c of ['gh pr create --base main --fill', 'git push -u origin x && gh pr create --base main', 'cd ../wt; gh pr new']) {
      const r = run(c)
      expect(r.status, c).toBe(2)
      expect(r.stderr).toContain('"Sites" lane session')
    }
  })

  it('lets other sessions, other commands and other tools through', () => {
    expect(run('gh pr create --base main', 'local_task-1111').status).toBe(0)
    expect(run('gh pr create --base main', null).status).toBe(0) // a terminal, not the app
    expect(run('gh pr view 52').status).toBe(0)
    expect(run('gh pr list').status).toBe(0)
    expect(run('gh pr create', LANE, 'Read').status).toBe(0)
  })

  it('lets one PR through with the unbind comment', () => {
    expect(run('gh pr create --base main --fill # lane-pr: unbind').status).toBe(0)
  })

  it('fails open on bad input or a missing registry', () => {
    expect(spawnSync('node', [HOOK], { input: 'nope', encoding: 'utf8' }).status).toBe(0)
    expect(run('gh pr create', LANE, 'Bash', path.join(dir, 'missing.json')).status).toBe(0)
  })
})
