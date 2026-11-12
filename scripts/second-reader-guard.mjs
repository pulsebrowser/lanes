#!/usr/bin/env node
/**
 * Second-reader gate. A Claude Code PreToolUse hook on Bash.
 *
 * It stops a `git commit` that includes a covered file (the JSON map `secondReader.coveredFiles` of
 * .claude/brain.json: area -> paths; a path ending in / covers a folder) when the commit message has no
 * `Second-Reader:` line. The step itself is the second-reader skill: a fresh agent that did not write the change
 * reads the staged diff. With no covered-files file the hook does nothing.
 *
 * Limits, on purpose:
 * - It checks agent sessions only. A commit typed by a person in a terminal does not go through it.
 * - The line is a statement by the session, not a proof that the read happened.
 * - It fails OPEN: on any error of its own (no git, bad JSON, no list) the commit goes through.
 *
 * Input: the hook JSON on stdin ({ tool_name, tool_input: { command }, cwd }). Exit 2 blocks; stderr goes to the agent.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { loadBrainConfig, GIT_PREFIX } from './brain-config.mjs'

const CONFIG = loadBrainConfig()
const READER = CONFIG.secondReader
const COMMIT = new RegExp(GIT_PREFIX + String.raw`commit(?=\s|$)`, 'g')
const ADD = new RegExp(GIT_PREFIX + String.raw`add\s+([^;&|\n]+)`, 'g')
// The trailer at a line start, after a quote, or after an escaped newline inside `printf '...\n...'`.
const TRAILER = /(?:^|[\n"']|\\n)[ \t]*Second-Reader:[ \t]*[A-Za-z0-9]/
// Options of `git commit` that take a value, so the value is not read as a path.
const COMMIT_VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-c', '-C', '--reuse-message', '--reedit-message',
  '--author', '--date', '--fixup', '--squash', '-t', '--template', '--cleanup', '--trailer'])
const unquote = (s) => s.replace(/^["']|["']$/g, '')
const words = (s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote)

/** Where a git command at `index` runs: `git -C <dir>`, else the last `cd <dir>` before it, else the session's dir. */
function dirFor(command, index, options, base) {
  const dashC = /-C(?:=|\s+)("[^"]+"|'[^']+'|\S+)/.exec(options || '')
  if (dashC) return path.resolve(base, unquote(dashC[1]))
  const cds = [...command.slice(0, index).matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)]
  return cds.length ? path.resolve(base, unquote(cds[cds.length - 1][1])) : base
}

/** Checks ONE `git commit` of the command. Returns the covered files it would commit without a trailer, by area. */
function check(command, hit, base, covered) {
  const dir = dirFor(command, hit.index, hit[1], base)
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').map((l) => l.trim()).filter(Boolean)
  // Paths as git sees them from the repository root, for pathspecs that are folders, globs or relative to a `cd`.
  const changedUnder = (specs) => (specs.length ? git('ls-files', '-m', '-o', '--exclude-standard', '--full-name', '--', ...specs) : [])

  const rest = command.slice(hit.index + hit[0].length)
  const segment = rest.split(/[;&|\n]/)[0]
  const files = new Set(git('diff', '--cached', '--name-only'))
  // `git commit -a` also takes every tracked change.
  if (/(?:^|\s)(-[a-zA-Z]*a[a-zA-Z]*|--all)(\s|$)/.test(segment)) git('diff', '--name-only').forEach((f) => files.add(f))
  // `git commit <paths>` or `git commit -- <paths>` commits those paths.
  const commitWords = words(segment)
  const specs = []
  for (let i = 0; i < commitWords.length; i++) {
    const w = commitWords[i]
    if (w === '--') { specs.push(...commitWords.slice(i + 1)); break }
    if (COMMIT_VALUE_OPTS.has(w)) { i++; continue }
    if (w.startsWith('-')) continue
    if (existsSync(path.resolve(dir, w))) specs.push(w) // a word of a message is not a path on disk
  }
  changedUnder(specs).forEach((f) => files.add(f))
  // `git add <paths> && git commit` in one command: the paths are not staged yet when this hook runs.
  for (const add of command.slice(0, hit.index).matchAll(ADD)) {
    const addDir = dirFor(command, add.index, add[1], base)
    const tokens = words(add[2])
    const all = tokens.some((t) => t === '-A' || t === '--all' || t === '-u' || t === '--update')
    const paths = tokens.filter((t) => !t.startsWith('-'))
    const found = execFileSync('git', ['ls-files', '-m', '-o', '--exclude-standard', '--full-name', '--', ...(all ? ['.'] : paths)],
      { cwd: all ? dir : addDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (all || paths.length) found.split('\n').map((l) => l.trim()).filter(Boolean).forEach((f) => files.add(f))
  }

  const areas = new Map()
  for (const f of files) {
    for (const [area, entries] of Object.entries(covered)) {
      if (!Array.isArray(entries)) continue
      if (entries.some((e) => (e.endsWith('/') ? f.startsWith(e) || f + '/' === e : f === e))) {
        areas.set(area, [...(areas.get(area) || []), f])
      }
    }
  }
  if (!areas.size) return null

  // The message: in the command text AFTER this `git commit` (-m, a heredoc), or in the file given to -F.
  let message = rest
  const dashF = /\s(?:-F\s*|--file(?:=|\s+))("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(' ' + segment)
  if (dashF) {
    const p = path.resolve(dir, unquote(dashF[1]))
    if (existsSync(p)) message += '\n' + readFileSync(p, 'utf8')
  }
  return TRAILER.test(message) ? null : areas
}

function main() {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { return 0 }
  if (input?.tool_name !== 'Bash') return 0
  const command = String(input?.tool_input?.command ?? '')
  const hits = [...command.matchAll(COMMIT)]
  if (!hits.length) return 0
  const coveredPath = path.resolve(CONFIG.projectDir, READER.coveredFiles)
  if (!existsSync(coveredPath)) return 0
  const covered = JSON.parse(readFileSync(coveredPath, 'utf8'))
  const base = input.cwd || process.cwd()

  // Every `git commit` in the command is checked, not only the first.
  let areas = null
  for (const hit of hits) {
    areas = check(command, hit, base, covered)
    if (areas) break
  }
  if (!areas) return 0

  const lines = [...areas].map(([a, fs]) => `  ${a}: ${fs.slice(0, 4).join(', ')}${fs.length > 4 ? `, and ${fs.length - 4} more` : ''}`)
  process.stderr.write(
    [
      'Commit stopped: a second reader is necessary.',
      'This commit changes covered files:',
      ...lines,
      '',
      'Do these steps, then commit again:',
      ...(READER.verifyCommand ? [`  0. Run ${READER.verifyCommand} ${[...areas.keys()].join(' and ')}. It must pass.`] : []),
      `  1. Do the second read (${READER.skill}): a fresh agent reads the staged diff.`,
      '  2. Add a line to the commit message, for example:',
      '       Second-Reader: fresh agent, 2 findings, 2 fixed',
      '',
      `Only ${CONFIG.owner} can skip the step. With that word for this commit, write:`,
      `       Second-Reader: skipped on ${CONFIG.owner}'s word`,
      '',
    ].join('\n'),
  )
  return 2
}

let code = 0
try { code = main() } catch { code = 0 }
process.exit(code)
