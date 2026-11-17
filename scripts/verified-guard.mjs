#!/usr/bin/env node
/**
 * The Verified line (0.6.1). A Claude Code PreToolUse hook on Bash.
 *
 * From Anthropic's "How the Claude Code team thinks about verification": every commit is stamped with how it was
 * verified, "none" included, so unverified commits can be found. Each `git commit` an agent runs must carry a line
 *
 *   Verified: tests (node --test, 152 pass), second-reader
 *   Verified: none (docs only)
 *
 * with one or more kinds from `verified.kinds` of .claude/brain.json (tests, app, tla, second-reader, none), each
 * with an optional note in brackets; "none" needs its reason. Put it in the trailer block at the end of the message,
 * so git reads it as a trailer: `git log --format='%h %(trailers:key=Verified,valueonly)'` lists them, and
 * lane-report.mjs counts them.
 *
 * Mode `guards.verified`, default "observe": it logs a commit that would have been stopped and stops nothing, so the
 * false positives can be read first. Set "enforce" to stop such commits; after two blocks in one session the next try
 * goes through, logged (guard-mode.mjs). It fails OPEN on any error of its own.
 *
 * Input: the hook JSON on stdin ({ tool_name, tool_input: { command }, cwd, session_id }). Exit 2 blocks.
 */
import { readFileSync } from 'node:fs'
import { loadBrainConfig } from './brain-config.mjs'
import { safeRules } from './rules.mjs'
import { decide, letThroughOutput, recordPass } from './guard-mode.mjs'
import { commitHits, commitMessage } from './commit-parse.mjs'
import { parseVerified } from './verified-line.mjs'

const CONFIG = loadBrainConfig()
function main() {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { return 0 }
  if (input?.tool_name !== 'Bash') return 0
  const command = String(input?.tool_input?.command ?? '')
  // Only real commits: "git commit" in a PR body, an echo or a heredoc is text (second read of 0.6.1).
  const hits = commitHits(command)
  if (!hits.length) return 0
  const rules = safeRules(CONFIG)
  if (rules.modes.verified === 'off') return 0
  const base = input.cwd || process.cwd()

  let error = null
  for (const hit of hits) {
    const r = parseVerified(commitMessage(command, hit, base), rules.kinds)
    if (r.error) { error = r.error; break }
  }
  if (!error) { recordPass('verified', { config: CONFIG, rules, session: input.session_id }); return 0 }

  const reason = `commit with ${error}`
  const d = decide('verified', { config: CONFIG, rules, session: input.session_id, reason, escape: true })
  if (d.letThrough) {
    process.stdout.write(letThroughOutput({ name: 'Verified gate', after: d.after, reason, owner: CONFIG.owner, file: CONFIG.guards.log }))
    return 0
  }
  if (!d.block) return 0
  const kinds = rules.kinds
  process.stderr.write(
    [
      `Commit stopped: ${error}.`,
      'Every commit says what was run to check it. Add one line at the end of the message, with the other trailers:',
      '  Verified: tests (node --test, 152 pass)',
      '  Verified: tests, app (drove the sign-in page), second-reader',
      '  Verified: none (docs only)',
      `Kinds: ${kinds.join(', ')}. A note in brackets is optional; "none" needs its reason.`,
      'Write only what was really run. "none" is an honest answer.',
      '',
    ].join('\n'),
  )
  return 2
}

let code = 0
try { code = main() } catch { code = 0 }
process.exit(code)
