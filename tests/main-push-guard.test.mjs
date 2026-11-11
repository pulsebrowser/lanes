import { describe, it, before as beforeAll, after as afterAll } from 'node:test'
import { expect } from './helpers.mjs'
import { spawnSync, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The main push guard (scripts/main-push-guard.mjs, 2026-11-10): an agent's `git push` that writes to
 * main is stopped, because changes reach main through a pull request. It runs against a temporary git
 * repository. Exit 2 = stopped. Exit 0 = the push goes through.
 */
const HOOK = path.join(process.cwd(), 'scripts/main-push-guard.mjs')
let repo = ''
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
const run = (command, tool = 'Bash') =>
  spawnSync('node', [HOOK], { input: JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: repo }), encoding: 'utf8' })

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'main-push-'))
  git('init', '-q', '-b', 'main')
  writeFileSync(path.join(repo, 'a.txt'), 'a\n')
  git('add', 'a.txt')
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'a')
})
afterAll(() => { if (repo) rmSync(repo, { recursive: true, force: true }) })

describe('main push guard', () => {
  it('stops pushes that name main', () => {
    for (const c of ['git push origin main', 'git push origin HEAD:main', 'git push -u origin feat/x:main', 'git push origin +HEAD:refs/heads/main', 'git fetch && git push origin main']) {
      const r = run(c)
      expect(r.status, c).toBe(2)
      expect(r.stderr).toContain('through a pull request')
    }
  })

  it('stops a bare push while on main, and lets it through on another branch', () => {
    expect(run('git push').status).toBe(2)
    expect(run('git push origin').status).toBe(2)
    git('switch', '-q', '-c', 'feat/y')
    expect(run('git push').status).toBe(0)
    expect(run('git push -u origin feat/y').status).toBe(0)
    expect(run('git push origin HEAD').status).toBe(0)
    git('switch', '-q', 'main')
  })

  it('lets through branch pushes, other commands and other tools', () => {
    expect(run('git push origin feat/maintenance').status).toBe(0)
    expect(run('git push origin main-docs').status).toBe(0)
    expect(run('git log origin/main').status).toBe(0)
    expect(run('git push origin main', 'Read').status).toBe(0)
    expect(run('git push --tags').status).toBe(0) // on main: tags only
    expect(run('git push origin v0.4.35').status).toBe(0)
  })

  it("lets one push through with Ada's word in the command", () => {
    expect(run("git push origin HEAD:main # main-push: Ada's word").status).toBe(0)
  })

  it('fails open on bad input', () => {
    expect(spawnSync('node', [HOOK], { input: 'nope', encoding: 'utf8' }).status).toBe(0)
  })
})
