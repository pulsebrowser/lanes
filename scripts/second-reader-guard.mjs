#!/usr/bin/env node
/**
 * Second-reader gate. A Claude Code PreToolUse hook on Bash.
 *
 * It stops a `git commit` that includes a covered file (the JSON map `secondReader.coveredFiles` of
 * .claude/brain.json: area -> paths; a path ending in / covers a folder) when the commit message has no
 * `Second-Reader:` line. The step itself is the second-reader skill: a fresh agent that did not write the change
 * reads the staged diff. With no covered-files list (in the working tree or on the base branch) the hook does nothing.
 *
 * Since 0.6.1 the gate cannot be edited by the change it judges (rules.mjs): the list is read from the base branch
 * too and the union counts, so a commit that drops a file from the list, or deletes the list, still needs the line;
 * and a commit that changes the rule files themselves (brain.json, a covered list) needs it as well. Its mode
 * (`guards.secondReader`: off, observe, enforce) and the let-through after two blocks are in guard-mode.mjs.
 *
 * Limits, on purpose:
 * - It checks agent sessions only. A commit typed by a person in a terminal does not go through it.
 * - The line is a statement by the session, not a proof that the read happened.
 * - It fails OPEN: on any error of its own (no git, bad JSON, no list) the commit goes through.
 *
 * Input: the hook JSON on stdin ({ tool_name, tool_input: { command }, cwd, session_id }). Exit 2 blocks; stderr goes
 * to the agent.
 */
import { readFileSync } from 'node:fs'
import { loadBrainConfig } from './brain-config.mjs'
import { safeRules } from './rules.mjs'
import { decide, letThroughOutput, recordPass } from './guard-mode.mjs'
import { COMMIT, commitFiles, commitMessage } from './commit-parse.mjs'

const CONFIG = loadBrainConfig()
const READER = CONFIG.secondReader
// The trailer at a line start, after a quote, or after an escaped newline inside `printf '...\n...'`.
const TRAILER = /(?:^|[\n"']|\\n)[ \t]*Second-Reader:[ \t]*[A-Za-z0-9]/
const RULES_AREA = 'guard rules'

const matches = (f, e) => (e.endsWith('/') ? f.startsWith(e) || f + '/' === e : f === e)

/** Checks ONE `git commit` of the command. Returns the covered files it would commit without a trailer, by area. */
function check(command, hit, base, rules) {
  const { files } = commitFiles(command, hit, base)
  const areas = new Map()
  for (const f of files) {
    for (const [area, entries] of Object.entries(rules.covered)) {
      if (Array.isArray(entries) && entries.some((e) => typeof e === 'string' && matches(f, e))) {
        areas.set(area, [...(areas.get(area) || []), f])
      }
    }
    if (rules.ruleFiles.includes(f)) areas.set(RULES_AREA, [...(areas.get(RULES_AREA) || []), f])
  }
  if (!areas.size) return null
  return TRAILER.test(commitMessage(command, hit, base)) ? null : areas
}

function main() {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { return 0 }
  if (input?.tool_name !== 'Bash') return 0
  const command = String(input?.tool_input?.command ?? '')
  const hits = [...command.matchAll(COMMIT)]
  if (!hits.length) return 0
  const rules = safeRules(CONFIG)
  if (!rules.covered || rules.modes.secondReader === 'off') return 0
  const base = input.cwd || process.cwd()

  // Every `git commit` in the command is checked, not only the first.
  let areas = null
  for (const hit of hits) {
    areas = check(command, hit, base, rules)
    if (areas) break
  }
  if (!areas) { recordPass('secondReader', { config: CONFIG, rules, session: input.session_id }); return 0 }

  const lines = [...areas].map(([a, fs]) => `  ${a}: ${fs.slice(0, 4).join(', ')}${fs.length > 4 ? `, and ${fs.length - 4} more` : ''}`)
  const reason = `commit without Second-Reader of ${[...areas].map(([a, fs]) => `${a} (${fs.slice(0, 2).join(', ')})`).join('; ')}`
  const d = decide('secondReader', { config: CONFIG, rules, session: input.session_id, reason, escape: true })
  if (d.letThrough) {
    process.stdout.write(letThroughOutput({ name: 'second-reader gate', after: d.after, reason, owner: CONFIG.owner, file: CONFIG.guards.log }))
    return 0
  }
  if (!d.block) return 0

  const verifyAreas = [...areas.keys()].filter((a) => a !== RULES_AREA)
  process.stderr.write(
    [
      'Commit stopped: a second reader is necessary.',
      'This commit changes covered files:',
      ...lines,
      ...(areas.has(RULES_AREA)
        ? ['', `"${RULES_AREA}" are the files that decide what this gate checks: a change to them is read like a covered file.`,
          'Until it is merged, the gate keeps the rules of the base branch too (the stricter of the two).']
        : []),
      '',
      'Do these steps, then commit again:',
      ...(READER.verifyCommand && verifyAreas.length ? [`  0. Run ${READER.verifyCommand} ${verifyAreas.join(' and ')}. It must pass.`] : []),
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
