import { describe, it, beforeEach, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 0.6.0: inbox items record how they were routed (lane, hops, reroute, answered, done, redone), and
 * scripts/lane-report.mjs prints it per lane. Items written before 0.6.0 must still read.
 */
const SCRIPT = (n) => path.join(process.cwd(), 'scripts', n)
const dir = mkdtempSync(path.join(os.tmpdir(), 'lanes-report-'))
const registry = path.join(dir, 'lanes.json')
afterAll(() => rmSync(dir, { recursive: true, force: true }))
const env = () => { const e = { ...process.env, LANE_REGISTRY: registry }; delete e.CLAUDE_CODE_HOST_SESSION_ID; return e }
const inbox = (args, text = '') => spawnSync('node', [SCRIPT('lane-inbox.mjs'), ...args], { input: text, encoding: 'utf8', env: env() })
const report = (args = []) => spawnSync('node', [SCRIPT('lane-report.mjs'), ...args], { encoding: 'utf8', env: env() })
const items = (slug) => JSON.parse(readFileSync(path.join(dir, `${slug}.inbox.json`), 'utf8')).items
const put = (slug, list) => writeFileSync(path.join(dir, `${slug}.inbox.json`), JSON.stringify({ items: list }))
const ago = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString()
const status = (session) => spawnSync('node', [SCRIPT('statusline.mjs')], { input: JSON.stringify({ session_id: session }), encoding: 'utf8', env: env() }).stdout.trim()

beforeEach(() => {
  for (const f of ['ops', 'web', 'old', 'conductor']) rmSync(path.join(dir, `${f}.inbox.json`), { force: true })
  rmSync(path.join(dir, 'retired'), { recursive: true, force: true })
  writeFileSync(registry, JSON.stringify({ lanes: [
    { slug: 'conductor', name: 'Conductor', role: 'conductor', sessionId: 'local_c', keywords: [] },
    { slug: 'ops', name: 'Ops', sessionId: 'local_o', keywords: ['nginx'] },
    { slug: 'web', name: 'Web', sessionId: 'local_w', keywords: ['homepage'] },
    { slug: 'old', name: 'Old', sessionId: null, retired: '2026-11-01', keywords: [] },
  ] }))
})

describe('routing fields', () => {
  it('add records the lane, one hop and when the request first arrived', () => {
    inbox(['add', 'ops', '--id', 'a1'], 'fix nginx')
    const i = items('ops')[0]
    expect(i.lane).toBe('ops')
    expect(i.hops).toBe(1)
    expect(i.firstAt).toBe(i.at)
  })

  it('answered is set once; done without answered marks the answer time as a guess', () => {
    inbox(['add', 'ops', '--id', 'a1'], 'one')
    inbox(['add', 'ops', '--id', 'a2'], 'two')
    expect(inbox(['answered', 'ops', 'a1']).status).toBe(0)
    const first = items('ops').find((i) => i.id === 'a1').answeredAt
    inbox(['answered', 'ops', 'a1'])
    expect(items('ops').find((i) => i.id === 'a1').answeredAt).toBe(first)
    inbox(['done', 'ops', 'a1', 'a2'])
    expect(items('ops').find((i) => i.id === 'a1').answeredWithDone).toBe(undefined)
    expect(items('ops').find((i) => i.id === 'a2').answeredWithDone).toBe(true)
    expect(inbox(['answered', 'ops', 'nope']).status).toBe(1)
  })

  it('reroute moves the request: the old lane keeps a closed copy, the new lane gets hop 2 with the first arrival time', () => {
    inbox(['add', 'ops', '--id', 'r1', '--from', 'local_c'], 'the homepage hero is blurry')
    const firstAt = items('ops')[0].firstAt
    const r = inbox(['reroute', 'ops', 'r1', 'web'])
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('Moved r1 from ops to web')
    const src = items('ops')[0]
    expect(src.status).toBe('rerouted')
    expect(src.reroutedTo).toBe('web')
    const dst = items('web')[0]
    expect(dst.status).toBe('pending')
    expect(dst.hops).toBe(2)
    expect(dst.rerouteFrom).toBe('ops')
    expect(dst.firstAt).toBe(firstAt)
    expect(dst.from).toBe('local_c')
    expect(status('local_o')).toBe('lane: Ops') // a moved request is not pending in the old lane
    expect(status('local_w')).toBe('lane: Web, inbox 1')
  })

  it('reroute refuses a retired, unknown or same lane, and then leaves the source as it was', () => {
    inbox(['add', 'ops', '--id', 'r1'], 'x')
    for (const to of ['old', 'nope', 'ops', '../x']) {
      expect(inbox(['reroute', 'ops', 'r1', to]).status).toBe(1)
      expect(items('ops')[0].status).toBe('pending')
    }
    expect(inbox(['reroute', 'ops', 'missing', 'web']).status).toBe(1)
  })

  it('redone reopens a done request and counts it', () => {
    inbox(['add', 'ops', '--id', 'd1'], 'x')
    inbox(['done', 'ops', 'd1'])
    expect(status('local_o')).toBe('lane: Ops')
    expect(inbox(['redone', 'ops', 'd1']).stdout).toContain('redone 1x')
    expect(inbox(['redone', 'ops', 'd1']).status).toBe(1) // not done again yet: refused
    inbox(['done', 'ops', 'd1'])
    inbox(['redone', 'ops', 'd1'])
    const i = items('ops')[0]
    expect(i.status).toBe('pending')
    expect(i.redone).toBe(2)
    expect(status('local_o')).toBe('lane: Ops, inbox 1')
  })

  it('items written before 0.6.0 still list, close and count', () => {
    put('ops', [{ id: 'old1', at: ago(5), from: '', text: 'an old request', status: 'pending' }])
    expect(inbox(['list', 'ops']).stdout).toContain('an old request')
    expect(inbox(['done', 'ops', 'old1']).status).toBe(0)
    const out = report().stdout
    expect(out).toContain('Requests: 1. The first lane kept 1 (100%)')
  })

  it('done items stay 60 days for the report (they were dropped after 7)', () => {
    put('ops', [
      { id: 'd30', at: ago(30 * 24), text: 'x', status: 'done', doneAt: ago(30 * 24) },
      { id: 'd70', at: ago(70 * 24), text: 'y', status: 'done', doneAt: ago(70 * 24) },
    ])
    inbox(['add', 'ops'], 'new')
    const ids = items('ops').map((i) => i.id)
    expect(ids.includes('d30')).toBe(true)
    expect(ids.includes('d70')).toBe(false)
  })
})

describe('lane-report.mjs', () => {
  const fixture = () => {
    put('ops', [
      { id: 'o1', at: ago(10), firstAt: ago(10), text: 'a', status: 'done', lane: 'ops', hops: 1, answeredAt: ago(9), doneAt: ago(8) },
      { id: 'o2', at: ago(6), firstAt: ago(6), text: 'b', status: 'done', lane: 'ops', hops: 1, answeredAt: ago(3), doneAt: ago(2), answeredWithDone: false },
      { id: 'o3', at: ago(5), firstAt: ago(5), text: 'c', status: 'rerouted', lane: 'ops', hops: 1, reroutedTo: 'web', reroutedAt: ago(4) },
      { id: 'o4', at: ago(1), firstAt: ago(1), text: 'd', status: 'pending', lane: 'ops', hops: 1, redone: 1 },
      { id: 'old', at: ago(30 * 24), firstAt: ago(30 * 24), text: 'outside the window', status: 'done', lane: 'ops', hops: 1, doneAt: ago(30 * 24) },
    ])
    put('web', [
      { id: 'o3', at: ago(4), firstAt: ago(5), text: 'c', status: 'done', lane: 'web', hops: 2, rerouteFrom: 'ops', doneAt: ago(3), answeredAt: ago(3), answeredWithDone: true },
    ])
  }

  it('counts per lane and in all, over the window', () => {
    fixture()
    const r = report(['--json'])
    expect(r.status).toBe(0)
    const { totals, lanes } = JSON.parse(r.stdout)
    const ops = lanes.find((l) => l.slug === 'ops')
    const web = lanes.find((l) => l.slug === 'web')
    expect(ops.requests).toBe(4)
    expect(ops.done).toBe(2)
    expect(ops.open).toBe(1)
    expect(ops.movedOut).toBe(1)
    expect(ops.redone).toBe(1)
    expect(ops.medianToAnswerMs).toBe(2 * 3600 * 1000) // 1 h and 3 h
    expect(ops.answerCount).toBe(2)
    expect(web.movedIn).toBe(1)
    expect(web.answerGuessed).toBe(1)
    expect(web.answerCount).toBe(0) // a guessed answer time is not counted
    expect(web.medianToDoneMs).toBe(2 * 3600 * 1000) // from the FIRST lane's arrival
    expect(totals.requests).toBe(4)
    expect(totals.firstLaneRight).toBe(3)
    expect(totals.meanHopsFinished).toBe((1 + 1 + 2) / 3)
    expect(lanes.some((l) => l.slug === 'conductor')).toBe(false)
  })

  it('prints a table with counts beside the figures', () => {
    fixture()
    const out = report().stdout
    expect(out).toContain('Lane report, last 14 days')
    expect(out).toContain('The first lane kept 3 (75%)')
    expect(out).toContain('2.0 h (2)')
    expect(out).toContain('read every figure with its count')
  })

  it('takes --days, reads retired inboxes, and survives a broken inbox or no data', () => {
    fixture()
    expect(JSON.parse(report(['--days', '60', '--json']).stdout).lanes.find((l) => l.slug === 'ops').requests).toBe(5)
    mkdirSync(path.join(dir, 'retired'), { recursive: true })
    writeFileSync(path.join(dir, 'retired', 'old.inbox.json'), JSON.stringify({ items: [{ id: 'z', at: ago(2), text: 'z', status: 'done', doneAt: ago(1) }] }))
    expect(report().stdout).toContain('Old (retired)')
    writeFileSync(path.join(dir, 'web.inbox.json'), '{broken')
    expect(report().status).toBe(0)
    for (const f of ['ops', 'web']) rmSync(path.join(dir, `${f}.inbox.json`), { force: true })
    rmSync(path.join(dir, 'retired'), { recursive: true, force: true })
    expect(report().stdout).toContain('No requests in this window.')
    expect(spawnSync('node', [SCRIPT('lane-report.mjs')], { encoding: 'utf8', env: { ...env(), LANE_REGISTRY: path.join(dir, 'none.json') } }).stdout).toContain('No lanes registry')
  })
})

describe('second read of 0.6.0', () => {
  it('a request moved back to a lane it left gets a new id there, and both records stay', () => {
    inbox(['add', 'ops', '--id', 'r1'], 'x')
    inbox(['reroute', 'ops', 'r1', 'web'])
    const back = inbox(['reroute', 'web', 'r1', 'ops'])
    expect(back.status).toBe(0)
    expect(back.stdout).toContain('as r1.h3')
    const ops = items('ops')
    expect(ops.find((i) => i.id === 'r1').status).toBe('rerouted')
    expect(ops.find((i) => i.id === 'r1.h3').hops).toBe(3)
    expect(JSON.parse(report(['--json']).stdout).totals.requests).toBe(1) // one request, not three
  })

  it('a pending request of a retired lane can be moved out', () => {
    mkdirSync(path.join(dir, 'retired'), { recursive: true })
    writeFileSync(path.join(dir, 'retired', 'old.inbox.json'), JSON.stringify({ items: [{ id: 'q1', at: ago(2), text: 'left over', status: 'pending' }] }))
    const r = inbox(['reroute', 'old', 'q1', 'ops'])
    expect(r.status).toBe(0)
    expect(items('ops')[0].text).toBe('left over')
    expect(JSON.parse(readFileSync(path.join(dir, 'retired', 'old.inbox.json'), 'utf8')).items[0].status).toBe('rerouted')
  })

  it('when the target refuses, the source is open again (never open in two lanes, never in none)', () => {
    inbox(['add', 'ops', '--id', 'r1'], 'x')
    put('web', [{ id: 'r1', at: ago(1), text: 'taken', status: 'pending' }, { id: 'r1.h2', at: ago(1), text: 'taken', status: 'pending' }])
    const r = inbox(['reroute', 'ops', 'r1', 'web'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('r1 is still open in ops')
    expect(items('ops')[0].status).toBe('pending')
    expect(items('ops')[0].reroutedTo).toBe(undefined)
  })

  it('a request finished while the move waits for the source lock is not moved (no copy left open in the target)', async () => {
    inbox(['add', 'ops', '--id', 'r1'], 'x')
    const lock = path.join(dir, 'ops.inbox.json.lock')
    writeFileSync(lock, 'the lane, marking it done')
    const p = spawn('node', [SCRIPT('lane-inbox.mjs'), 'reroute', 'ops', 'r1', 'web'], { env: env() })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    const done = new Promise((resolve) => p.on('exit', resolve))
    await new Promise((r) => setTimeout(r, 300))
    const data = JSON.parse(readFileSync(path.join(dir, 'ops.inbox.json'), 'utf8'))
    data.items[0].status = 'done'
    data.items[0].doneAt = new Date().toISOString()
    writeFileSync(path.join(dir, 'ops.inbox.json'), JSON.stringify(data))
    rmSync(lock, { force: true })
    await done
    expect(err).toContain('No open request r1')
    expect(existsSync(path.join(dir, 'web.inbox.json'))).toBe(false)
  })

  it('one redo is counted once, in the lane where it happened', () => {
    inbox(['add', 'ops', '--id', 'r2'], 'x')
    inbox(['done', 'ops', 'r2'])
    inbox(['redone', 'ops', 'r2'])
    inbox(['reroute', 'ops', 'r2', 'web'])
    const { lanes } = JSON.parse(report(['--json']).stdout)
    expect(lanes.find((l) => l.slug === 'ops').redone).toBe(1)
    expect(lanes.find((l) => l.slug === 'web').redone).toBe(0)
  })

  it('after four lanes, a request goes to the owner, not to a fifth lane', () => {
    writeFileSync(registry, JSON.stringify({ lanes: ['a', 'b', 'c', 'd', 'e'].map((x) => ({ slug: x, name: x.toUpperCase(), sessionId: null, keywords: [] })) }))
    inbox(['add', 'a', '--id', 'h'], 'x')
    expect(inbox(['reroute', 'a', 'h', 'b']).status).toBe(0)
    expect(inbox(['reroute', 'b', 'h', 'c']).status).toBe(0)
    expect(inbox(['reroute', 'c', 'h', 'd']).status).toBe(0)
    expect(inbox(['reroute', 'd', 'h', 'e']).stderr).toContain('ask the owner')
    for (const x of ['a', 'b', 'c', 'd', 'e']) rmSync(path.join(dir, `${x}.inbox.json`), { force: true })
  })

  it('the lane guard teaches answered, done and "not my lane"', () => {
    inbox(['add', 'ops'], 'check the disk')
    const out = spawnSync('node', [SCRIPT('lane-guard.mjs')], { input: JSON.stringify({ prompt: 'go', session_id: 'x' }), encoding: 'utf8', env: { ...env(), CLAUDE_CODE_HOST_SESSION_ID: 'local_o' } }).stdout
    expect(out).toContain('answered ops <id>')
    expect(out).toContain('Answer the owner HERE')
    expect(out).toContain('not my lane')
  })

  it('a window longer than inbox.keepDays is cut to it, and says so', () => {
    const out = report(['--days', '365']).stdout
    expect(out).toContain('last 60 days')
    expect(out).toContain('inboxes keep only 60 days')
  })

  it('done or answered on a request that was moved fails and says where it went', () => {
    inbox(['add', 'ops', '--id', 'm1'], 'x')
    inbox(['reroute', 'ops', 'm1', 'web'])
    const d = inbox(['done', 'ops', 'm1'])
    expect(d.status).toBe(1)
    expect(d.stderr).toContain('m1 (moved to web)')
    expect(inbox(['answered', 'ops', 'm1']).stderr).toContain('was moved to web')
  })

  it('a target that cannot be read puts the request back in the source (the write-crash path shares this put-back)', () => {
    inbox(['add', 'ops', '--id', 'c1'], 'x')
    mkdirSync(path.join(dir, 'web.inbox.json'), { recursive: true }) // the target path is a folder: its read throws
    const r = inbox(['reroute', 'ops', 'c1', 'web'])
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('c1 is still open in ops')
    expect(items('ops')[0].status).toBe('pending')
    rmSync(path.join(dir, 'web.inbox.json'), { recursive: true, force: true })
  })

  it('a long id moved back keeps its hop number and stays within 64 characters', () => {
    const id = 'x'.repeat(64)
    inbox(['add', 'ops', '--id', id], 'x')
    inbox(['reroute', 'ops', id, 'web'])
    const out = inbox(['reroute', 'web', id, 'ops']).stdout
    const newId = 'x'.repeat(61) + '.h3'
    expect(out).toContain(`as ${newId}`)
    expect(items('ops').some((i) => i.id === newId)).toBe(true)
  })
})
