import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The second-reader commit hook (scripts/second-reader-guard.mjs, 2026-11-10).
 * It runs against a temporary git repository, so it needs no credentials and never reads this repository's index.
 * Exit 2 = the commit is stopped. Exit 0 = the commit goes through.
 */
const HOOK = path.join(process.cwd(), 'scripts/second-reader-guard.mjs')
let repo = ''

const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
const run = (command, tool = 'Bash') => {
  const r = spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: repo }), encoding: 'utf8' })
  return { code: r.status, err: r.stderr }
}
const unstage = () => git('reset', '-q')

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'second-reader-'))
  git('init', '-q')
  mkdirSync(path.join(repo, 'lib'), { recursive: true })
  mkdirSync(path.join(repo, 'app/api/briefs/x'), { recursive: true })
  writeFileSync(path.join(repo, 'lib/billing-service.ts'), 'export const a = 1\n')
  writeFileSync(path.join(repo, 'lib/other.ts'), 'export const b = 1\n')
  writeFileSync(path.join(repo, 'app/api/briefs/x/route.ts'), 'export const c = 1\n')
})
afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }) })

describe('second-reader hook', () => {
  it('stops a commit of a covered file with no Second-Reader line', () => {
    unstage(); git('add', 'lib/billing-service.ts')
    const r = run('git commit -m "fix billing"')
    expect(r.code).toBe(2)
    expect(r.err).toContain('a second reader is necessary')
    expect(r.err).toContain('billing: lib/billing-service.ts')
  })

  it('lets the commit through with the line, in -m or in a heredoc', () => {
    unstage(); git('add', 'lib/billing-service.ts')
    expect(run('git commit -m "fix billing" -m "Second-Reader: fresh agent, no findings"').code).toBe(0)
    expect(run('git commit -m "$(cat <<\'EOF\'\nfix billing\n\nSecond-Reader: fresh agent, 2 findings, 2 fixed\nEOF\n)"').code).toBe(0)
  })

  it('reads the line from a message file (-F)', () => {
    unstage(); git('add', 'lib/billing-service.ts')
    writeFileSync(path.join(repo, 'msg.txt'), "fix billing\n\nSecond-Reader: skipped on Ada's word\n")
    expect(run('git commit -F msg.txt').code).toBe(0)
  })

  it('does not accept an empty line or the words in the subject', () => {
    unstage(); git('add', 'lib/billing-service.ts')
    expect(run('git commit -m "fix" -m "Second-Reader:"').code).toBe(2)
    expect(run('git commit -m "no Second-Reader: needed here"').code).toBe(2)
  })

  it('covers a directory entry', () => {
    unstage(); git('add', 'app/api/briefs/x/route.ts')
    const r = run('git commit -m "briefs"')
    expect(r.code).toBe(2)
    expect(r.err).toContain('briefs: app/api/briefs/x/route.ts')
  })

  it('sees a file that the same command stages', () => {
    unstage()
    expect(run('git add lib/billing-service.ts && git commit -m x').code).toBe(2)
    expect(run('git add -A && git commit -m x').code).toBe(2)
  })

  it('lets an uncovered file, another command and another tool through', () => {
    unstage(); git('add', 'lib/other.ts')
    expect(run('git commit -m "other"').code).toBe(0)
    unstage(); git('add', 'lib/billing-service.ts')
    expect(run('git status && git log -1').code).toBe(0)
    expect(run('echo "git commit is a phrase"; ls').code).toBe(0) // quoted words are not a commit
    expect(run('git commit -m x', 'Edit').code).toBe(0)
  })

  it('follows git -C and cd to the repository', () => {
    unstage(); git('add', 'lib/billing-service.ts')
    const from = (command) => spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: os.tmpdir() }), encoding: 'utf8' }).status
    expect(from(`git -C ${repo} commit -m x`)).toBe(2)
    expect(from(`cd ${repo} && git commit -m x`)).toBe(2)
  })

  it('fails open on input it cannot read', () => {
    expect(spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' }).status).toBe(0)
  })
})
