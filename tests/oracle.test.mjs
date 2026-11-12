import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * Git is the judge. Each generated command RUNS against a scratch repository, and the guard's verdict must agree
 * with what git really did:
 * - push guard: did the remote's main move? If it did, the guard must have stopped the command (a miss otherwise).
 * - second reader: did a covered file land in the new commit? If it did, the guard must have stopped it.
 * A guard that stops a command git would have run harmlessly is a false block: counted and printed, not failed
 * (a guard may be careful). Hand-written tests cover the cases someone thought of; these cover the space between.
 */
// About 4 minutes: off in a plain `node --test`, on with LANES_ORACLE=1 (its own CI job).
const OFF = process.env.LANES_ORACLE !== '1'
const SCRIPT = (n) => path.join(process.cwd(), 'scripts', n)
const tmp = mkdtempSync(path.join(os.tmpdir(), 'lanes-oracle-'))
afterAll(() => rmSync(tmp, { recursive: true, force: true }))
const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const guard = (name, command, cwd, env = {}) =>
  spawnSync('node', [SCRIPT(name)], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }), encoding: 'utf8', env: { ...process.env, ...env } }).status
const sh = (command, cwd) => spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, ...ID, GIT_TERMINAL_PROMPT: '0' } })

describe('push guard against git itself', { skip: OFF }, () => {
  const remote = path.join(tmp, 'remote.git')
  const work = path.join(tmp, 'work')
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, ...ID } }).trim()
  let base = ''
  beforeAll(() => {
    mkdirSync(remote); g(remote, 'init', '-q', '--bare', '-b', 'main')
    g(tmp, 'clone', '-q', remote, work)
    g(work, 'switch', '-q', '-c', 'main')
    writeFileSync(path.join(work, 'a'), 'base'); g(work, 'add', 'a'); g(work, 'commit', '-q', '-m', 'base')
    g(work, 'push', '-q', '-u', 'origin', 'main')
    base = g(work, 'rev-parse', 'HEAD')
    g(work, 'switch', '-q', '-c', 'feat'); writeFileSync(path.join(work, 'f'), 'f'); g(work, 'add', 'f'); g(work, 'commit', '-q', '-m', 'f')
    g(work, 'switch', '-q', 'main'); writeFileSync(path.join(work, 'm'), 'm'); g(work, 'add', 'm'); g(work, 'commit', '-q', '-m', 'm')
    g(work, 'tag', 't1')
  })
  const reset = () => {
    for (const ref of g(remote, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean)) g(remote, 'update-ref', '-d', ref)
    g(remote, 'update-ref', 'refs/heads/main', base)
    g(work, 'update-ref', 'refs/remotes/origin/main', base) // so --force-with-lease sees the remote as it is
    g(work, 'branch', '-q', '--set-upstream-to=origin/main', 'main') // a -u in an earlier case may have moved it
  }

  it('never lets a push that moves main through', () => {
    const prefixes = ['git', '/usr/bin/env git', 'git --no-pager', 'git -C .', 'git -c push.default=simple']
    const flags = ['', '-f', '-u', '--force-with-lease', '-q']
    const refspecs = ['', 'origin', 'origin main', 'origin HEAD', 'origin @', 'origin HEAD:main', 'origin feat:main', 'origin +feat:main',
      'origin refs/heads/main', 'origin HEAD:refs/heads/main', 'origin feat', 'origin feat:feat', '--all origin', '--mirror origin',
      '--tags origin', 'origin t1', 'origin main:other', 'origin feat:refs/heads/main']
    const wraps = [(c) => c, (c) => `cd . && ${c}`, (c) => `${c} && echo done`, (c) => `true; ${c}`]
    const misses = []
    const careful = []
    let n = 0
    for (const branch of ['main', 'feat']) {
      g(work, 'switch', '-q', branch)
      for (const p of prefixes) for (const f of flags) for (const r of refspecs) {
        if (r.startsWith('--') && f) continue // --all/--mirror/--tags with -u etc. adds nothing new
        const wrap = wraps[n++ % wraps.length]
        const command = wrap(`${p} push ${f} ${r}`.replace(/\s+/g, ' ').trim())
        reset()
        const blocked = guard('main-push-guard.mjs', command, work) === 2
        sh(command + ' >/dev/null 2>&1', work)
        const moved = g(remote, 'rev-parse', 'refs/heads/main') !== base
        if (moved && !blocked) misses.push(`[on ${branch}] ${command}`)
        if (!moved && blocked) careful.push(`[on ${branch}] ${command}`)
      }
    }
    g(work, 'switch', '-q', 'main')
    console.log(`push oracle: ${n} commands, ${misses.length} misses, ${careful.length} careful blocks`)
    if (process.env.LANES_ORACLE_VERBOSE) console.log(careful.join('\n'))
    assert.deepEqual(misses, [], `pushes that moved main and were NOT stopped:\n${misses.join('\n')}`)
  })
})

describe('second reader against git itself', { skip: OFF }, () => {
  const repo = path.join(tmp, 'reader')
  const covered = path.join(tmp, 'covered.json')
  const cfg = path.join(tmp, 'brain.json')
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...ID } }).trim()
  let base = ''
  beforeAll(() => {
    mkdirSync(path.join(repo, 'lib'), { recursive: true }); mkdirSync(path.join(repo, 'docs'))
    g('init', '-q', '-b', 'main')
    for (const f of ['lib/billing.ts', 'lib/other.ts', 'docs/readme.md']) writeFileSync(path.join(repo, f), 'v1\n')
    g('add', '.'); g('commit', '-q', '-m', 'base')
    base = g('rev-parse', 'HEAD')
    writeFileSync(covered, JSON.stringify({ billing: ['lib/billing.ts'] }))
    writeFileSync(cfg, JSON.stringify({ secondReader: { coveredFiles: covered } }))
  })

  it('never lets a commit of a covered file through without a trailer', () => {
    const setups = {
      'billing changed': () => writeFileSync(path.join(repo, 'lib/billing.ts'), 'v2\n'),
      'other changed': () => writeFileSync(path.join(repo, 'lib/other.ts'), 'v2\n'),
      'both changed': () => { writeFileSync(path.join(repo, 'lib/billing.ts'), 'v2\n'); writeFileSync(path.join(repo, 'lib/other.ts'), 'v2\n') },
      'billing staged': () => { writeFileSync(path.join(repo, 'lib/billing.ts'), 'v2\n'); g('add', 'lib/billing.ts') },
      'other staged, billing changed': () => { writeFileSync(path.join(repo, 'lib/other.ts'), 'v2\n'); g('add', 'lib/other.ts'); writeFileSync(path.join(repo, 'lib/billing.ts'), 'v2\n') },
      'docs changed': () => writeFileSync(path.join(repo, 'docs/readme.md'), 'v2\n'),
    }
    const commands = [
      'git commit -m x', 'git commit -am x', 'git commit -a -m x', 'git commit --all -m x', 'git --no-pager commit -am x', 'git -C . commit -am x',
      'git commit lib/billing.ts -m x', 'git commit -m x -- lib/billing.ts', 'git commit -m x lib/other.ts', 'git commit -m x lib',
      'git add lib && git commit -m x', 'git add lib/other.ts && git commit -m x', 'git add . && git commit -m x', 'git add -A && git commit -m x',
      'git add -u && git commit -m x', 'git add --all && git commit -m x', 'cd lib && git add billing.ts && git commit -m x', 'cd lib && git commit -am x',
      'cd lib && git add . && git commit -m x', "git add 'lib/*.ts' && git commit -m x", 'git add docs && git commit -m x', 'git add lib/billing.ts; git commit -m x',
      'git commit -q -m "fix it" -a', 'git commit -m "touch lib/billing.ts" -a',
      // second review (2026-11-12): -A/-u from a subfolder stage the WHOLE repo; a message glued to -m is not a path
      'cd docs && git add -A && git commit -m x', 'cd docs && git add -u && git commit -m x', 'cd docs && git add --all && git commit -m x',
      'git commit -am ..', 'git commit -sm /', 'git commit -vm .', 'git commit -am "use --all flag"',
      'git add /etc/hosts ; git commit -m x', 'git -C /tmp add x; git commit -m x', 'git add nope.txt; git commit -am x',
    ]
    const misses = []
    let falseBlocks = 0
    let n = 0
    for (const [label, setup] of Object.entries(setups)) {
      for (const command of commands) {
        g('reset', '-q', '--hard', base); g('clean', '-fdq'); setup()
        const blocked = guard('second-reader-guard.mjs', command, repo, { BRAIN_CONFIG: cfg }) === 2
        sh(command + ' >/dev/null 2>&1', repo)
        const head = g('rev-parse', 'HEAD')
        const landed = head !== base && g('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD').split('\n').includes('lib/billing.ts')
        n++
        if (landed && !blocked) misses.push(`[${label}] ${command}`)
        if (!landed && blocked) falseBlocks++
      }
    }
    console.log(`commit oracle: ${n} commands, ${misses.length} misses, ${falseBlocks} careful blocks`)
    assert.deepEqual(misses, [], `commits of a covered file that were NOT stopped:\n${misses.join('\n')}`)
  })
})
