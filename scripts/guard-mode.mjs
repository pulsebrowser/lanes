/**
 * Guard modes and the guard log (0.6.1), from Anthropic's "How the Claude Code team thinks about verification":
 * a gate has three modes, off, observe and enforce. Observe logs what would have been blocked, so false positives
 * can be read before the gate blocks anyone. And a commit gate that has blocked a session twice IN A ROW (no commit
 * it passed between, both within the last hour) lets the next try through, so a session is never stuck behind a gate
 * that is wrong; the let-through is logged and shown to the user.
 *
 * Every decision is one JSON line in `guards.log` (default <lanesDir>/guard-log.jsonl, outside git):
 *   { at, guard, mode, decision: "blocked" | "would-block" | "let-through" | "passed", session, reason }
 * ("passed" is written only by an enforced commit gate, for a session, to end a run of blocks.)
 * The command itself is not logged, only the guard's short reason. lane-report.mjs counts these lines.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { withLock, writeWhole } from './lock.mjs'

const MAX_BYTES = 1024 * 1024
const KEEP_LINES = 1000 // a line is at most about 500 bytes: the kept part stays under MAX_BYTES
const WINDOW = 60 * 60 * 1000
const one = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

/** Read the log; a broken line is skipped. */
export function readGuardLog(file) {
  let text = ''
  try { text = existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { text = '' }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { const e = JSON.parse(line); if (e && typeof e === 'object') out.push(e) } catch { /* skip */ }
  }
  return out
}

function log(file, entry) {
  try {
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n')
    if (statSync(file).size > MAX_BYTES) {
      withLock(file, () => {
        const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
        writeWhole(file, lines.slice(-KEEP_LINES).join('\n') + '\n')
      })
    }
    return true
  } catch { return false }
}

/** How many times in a row this guard blocked this session: since it last passed or let one through, in the hour. */
function blocksInARow(file, guard, session) {
  const since = Date.now() - WINDOW
  let n = 0
  for (const e of readGuardLog(file)) {
    if (e.guard !== guard || e.session !== session) continue
    if (e.decision === 'let-through' || e.decision === 'passed') n = 0
    else if (e.decision === 'blocked' && Date.parse(e.at) >= since) n++
  }
  return n
}

/** A commit gate passed a commit of this session: the next block starts a new run. Only when enforced. */
export function recordPass(guard, { config, rules, session }) {
  const mode = rules?.modes?.[guard] ?? config.guards[guard]
  const s = one(session, 80)
  if (mode !== 'enforce' || !s) return
  // Only after a block: a session that is never blocked writes nothing.
  const last = readGuardLog(config.guards.log).reverse().find((e) => e.guard === guard && e.session === s)
  if (last?.decision === 'blocked') log(config.guards.log, { guard, mode, session: s, decision: 'passed', reason: '' })
}

/**
 * What a guard does with a command it would block. Returns { block, letThrough, mode }.
 * - off: nothing is logged, nothing blocked.
 * - observe: logged as "would-block", let through.
 * - enforce: logged as "blocked" and blocked; for a gate with `escape` (the commit gates), once it has blocked this
 *   session `letThroughAfter` times, the next try is let through and logged as "let-through". With no session id
 *   the blocks cannot be counted, so nothing is let through.
 */
export function decide(guard, { config, rules, session, reason, escape = false }) {
  const mode = rules?.modes?.[guard] ?? config.guards[guard]
  const file = config.guards.log
  const entry = { guard, mode, session: one(session, 80) || null, reason: one(reason, 300) }
  if (mode === 'off') return { block: false, mode }
  if (mode === 'observe') { log(file, { ...entry, decision: 'would-block' }); return { block: false, mode } }
  const after = rules?.letThroughAfter ?? config.guards.letThroughAfter
  if (escape && after > 0 && entry.session && blocksInARow(file, guard, entry.session) >= after) {
    log(file, { ...entry, decision: 'let-through' })
    return { block: false, letThrough: true, after, mode }
  }
  log(file, { ...entry, decision: 'blocked' })
  return { block: true, mode }
}

/** The PreToolUse output for a let-through: a note for the model and a warning the user sees. Exit 0 after it. */
export function letThroughOutput({ name, after, reason, owner, file }) {
  const text = `The ${name} let this command through: it had blocked this session ${after} times, so it stands aside ` +
    `once (a gate that is wrong must not leave a session stuck). What it would have stopped: ${one(reason, 300)}. ` +
    `Logged in ${file}.`
  return JSON.stringify({
    systemMessage: text,
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `${text} Tell ${owner} in your reply that this check was skipped and why; do not count on it happening again.`,
    },
  }) + '\n'
}
