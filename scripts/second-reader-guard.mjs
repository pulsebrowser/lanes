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
import { loadBrainConfig } from './brain-config.mjs'

const CONFIG = loadBrainConfig()
const READER = CONFIG.secondReader
const COMMIT = /(?:^|[\s;&|(])git((?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)|\s+-c\s+\S+)*)\s+commit(?=\s|$)/
const TRAILER = /(?:^|[\n"'])[ \t]*Second-Reader:[ \t]*[A-Za-z0-9]/
const unquote = (s) => s.replace(/^["']|["']$/g, '')

function main() {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { return 0 }
  if (input?.tool_name !== 'Bash') return 0
  const command = String(input?.tool_input?.command ?? '')
  const hit = COMMIT.exec(command)
  if (!hit) return 0

  // Where the commit runs: `git -C <dir>`, else the last `cd <dir>` before it, else the session's directory.
  let dir = input.cwd || process.cwd()
  const dashC = /-C\s+("[^"]+"|'[^']+'|\S+)/.exec(hit[1] || '')
  const cds = [...command.slice(0, hit.index).matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)]
  if (dashC) dir = path.resolve(dir, unquote(dashC[1]))
  else if (cds.length) dir = path.resolve(dir, unquote(cds[cds.length - 1][1]))

  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .split('\n').map((l) => l.trim()).filter(Boolean)

  const covered = JSON.parse(readFileSync(path.resolve(CONFIG.projectDir, READER.coveredFiles), 'utf8'))
  const files = new Set(git('diff', '--cached', '--name-only'))
  // `git commit -a` also takes every tracked change.
  if (/\scommit\b[^;&|]*\s(-[a-zA-Z]*a[a-zA-Z]*|--all)(\s|$)/.test(command)) git('diff', '--name-only').forEach((f) => files.add(f))
  // `git add <paths> && git commit` in one command: the paths are not staged yet when this hook runs.
  for (const add of command.slice(0, hit.index).matchAll(/(?:^|[\s;&|(])git(?:\s+-C\s+\S+)*\s+add\s+([^;&|\n]+)/g)) {
    const tokens = add[1].trim().split(/\s+/).map(unquote)
    if (tokens.some((t) => t === '-A' || t === '--all' || t === '.' || t === '-u' || t === '--update')) {
      git('status', '--porcelain', '-uall').forEach((l) => files.add(l.slice(2).trim().split(' -> ').pop()))
    }
    tokens.filter((t) => !t.startsWith('-')).forEach((t) => files.add(t.replace(/^\.\//, '')))
  }

  const areas = new Map()
  for (const f of files) {
    for (const [area, entries] of Object.entries(covered)) {
      if (entries.some((e) => (e.endsWith('/') ? f.startsWith(e) || f + '/' === e : f === e))) {
        areas.set(area, [...(areas.get(area) || []), f])
      }
    }
  }
  if (!areas.size) return 0

  // The message: in the command text (-m, a heredoc) or in the file given to -F.
  let message = command
  const dashF = /\s(?:-F|--file)[=\s]+("[^"]+"|'[^']+'|\S+)/.exec(command.slice(hit.index))
  if (dashF) {
    const p = path.resolve(dir, unquote(dashF[1]))
    if (existsSync(p)) message += '\n' + readFileSync(p, 'utf8')
  }
  if (TRAILER.test(message)) return 0

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
