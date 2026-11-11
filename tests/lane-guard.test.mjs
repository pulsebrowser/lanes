import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The lane guard (scripts/lane-guard.mjs, 2026-11-10): a UserPromptSubmit hook that stops the first
 * message of a new session when a lane already has a session for that work. It runs against a temporary
 * registry, transcript and scheduled-tasks folder, so it reads nothing on this machine.
 * Exit 2 = stopped. Exit 0 = the message goes through.
 */
const HOOK = path.join(process.cwd(), 'scripts/lane-guard.mjs')
let dir = ''
let registry = ''
let tasks = ''

const run = (prompt, transcript) => {
  let transcript_path
  if (transcript) {
    transcript_path = path.join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`)
    writeFileSync(transcript_path, transcript.join('\n') + '\n')
  }
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, transcript_path, session_id: 'x' }),
    encoding: 'utf8',
    env: { ...process.env, LANE_REGISTRY: registry, LANE_TASKS_DIR: tasks },
  })
  return { code: r.status, err: r.stderr, out: r.stdout }
}
const userLine = (text) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'lane-guard-'))
  registry = path.join(dir, 'lanes.json')
  tasks = path.join(dir, 'tasks')
  writeFileSync(
    registry,
    JSON.stringify({
      lanes: [
        { slug: 'pulse-local', name: 'Pulse Local', title: 'Pulse Local', sessionId: 'local_a', keywords: ['pulse local', 'budgetbench', 'qwen'] },
        { slug: 'pulse-hosted', name: 'Pulse Hosted', title: 'Pulse Hosted', sessionId: 'local_b', keywords: ['net worth', 'plaid'] },
        { slug: 'sites', name: 'Sites', title: null, sessionId: null, keywords: ['run tokyo', 'adcap'] },
      ],
    }),
  )
  mkdirSync(path.join(tasks, 'namban-watch'), { recursive: true })
  writeFileSync(
    path.join(tasks, 'namban-watch', 'SKILL.md'),
    '---\nname: namban-watch\ndescription: x\n---\n\nCheck the Namban Rengo page for Run Tokyo race dates and report changes. Use the qwen budgetbench words only as a test.\n',
  )
})
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

describe('lane guard', () => {
  it('stops the first message of a new session that matches a lane with a session', () => {
    const r = run('Can you rerun budgetbench on the new qwen build?')
    expect(r.code).toBe(2)
    expect(r.err).toContain('Pulse Local work')
    expect(r.err).toContain('"Pulse Local"')
    expect(r.err).toContain('Can you rerun budgetbench') // the message is given back to copy
  })

  it('treats a transcript with only system lines as a new session', () => {
    expect(run('fix the net worth chart', [JSON.stringify({ type: 'queue-operation' }), userLine('<command-name>/model</command-name>')]).code).toBe(2)
  })

  it('lets later messages of a session through', () => {
    expect(run('now rerun budgetbench', [userLine('hello, look at the release'), userLine('now rerun budgetbench')]).code).toBe(0)
  })

  it('lets a message through with the new: prefix', () => {
    expect(run('new: a one-off budgetbench check').code).toBe(0)
  })

  it('passes lane: and tells the model to read the state file', () => {
    const r = run('lane: pulse-local continue the release')
    expect(r.code).toBe(0)
    expect(r.out).toContain('pulse-local.md')
    expect(r.out).toContain('rename it to that')
    expect(r.out).toContain('"Pulse Local"')
  })

  it('lane: matches the words of a hyphenated slug and names the lane title', () => {
    const r = run('lane: pulse hosted')
    expect(r.code).toBe(0)
    expect(r.out).toContain('pulse-hosted.md')
    expect(r.out).toContain('"Pulse Hosted"')
  })

  it('lets a message through when no lane matches, or when two lanes tie', () => {
    expect(run('what time is it in Tokyo?').code).toBe(0)
    expect(run('compare the plaid sync with budgetbench').code).toBe(0)
  })

  it('lets a message through when the lane has no session yet', () => {
    expect(run('update the run tokyo race list').code).toBe(0)
  })

  it('matches whole phrases only', () => {
    expect(run('the qwenlike model').code).toBe(0)
  })

  it('lets scheduled task runs through', () => {
    expect(run('Check the Namban Rengo page for Run Tokyo race dates and report changes. Use the qwen budgetbench words only as a test.').code).toBe(0)
  })

  it('fails open on bad input or a missing registry', () => {
    expect(spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' }).status).toBe(0)
    const r = spawnSync('node', [HOOK], {
      input: JSON.stringify({ prompt: 'budgetbench' }),
      encoding: 'utf8',
      env: { ...process.env, LANE_REGISTRY: path.join(dir, 'missing.json') },
    })
    expect(r.status).toBe(0)
  })
})
