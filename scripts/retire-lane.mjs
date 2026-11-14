#!/usr/bin/env node
/**
 * Retire a lane that is no longer needed (0.4.1).
 *
 *   node scripts/retire-lane.mjs <slug>            # retire
 *   node scripts/retire-lane.mjs <slug> --undo     # bring it back
 *
 * Retiring: lanes.json marks the entry `"retired": "<YYYY-MM-DD>"` and clears its `sessionId` (the entry stays, so the
 * history and the keywords are kept and the step can be undone), and the state file moves to `<lanesDir>/retired/`.
 * After that the lane guard never matches a new session to it, `lane: <slug>` does not claim it, the conductor
 * never routes to it, and the status line never names it.
 *
 * It does NOT archive the lane's session: that is an app action, and the owner may archive any session at any
 * time. Before running this, move the rules in the state file that outlive the lane to CLAUDE.md or the docs.
 * The registry is changed under the same lock file as a claim (`lanes.json.lock`) and re-read under it.
 *
 * Env: LANE_REGISTRY (tests: path of lanes.json), CLAUDE_PROJECT_DIR (the project).
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs'
import path from 'node:path'
import { loadBrainConfig, isSafeSlug } from './brain-config.mjs'

const [slug, flag] = process.argv.slice(2)
const undo = flag === '--undo'
// Exit only after stderr is written (a pipe is written asynchronously; process.exit() could drop the message).
const fail = (msg) => { process.stderr.write(msg + '\n', () => process.exit(1)); return new Promise(() => {}) }

if (!isSafeSlug(slug)) await fail('Usage: node scripts/retire-lane.mjs <slug> [--undo]')
const registry = process.env.LANE_REGISTRY || path.join(loadBrainConfig().lanesDir, 'lanes.json')
if (!existsSync(registry)) await fail(`No lanes registry at ${registry}.`)
const dir = path.dirname(registry)

/** The same lock as the lane guard's claim: one writer at a time, a lock older than 5 s is a dead process's. */
function withLock(fn) {
  const lock = `${registry}.lock`
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  const token = `${process.pid}-${Date.now()}-retire`
  let fd = null
  for (let i = 0; i < 200 && fd === null; i++) {
    try { fd = openSync(lock, 'wx'); writeFileSync(fd, token) } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) { const gone = `${lock}.stale.${token}`; renameSync(lock, gone); unlinkSync(gone) }
      } catch { /* another waiter got there first */ }
      sleep(10)
    }
  }
  if (fd === null) return { error: 'lanes.json is locked by another writer; try again.' }
  try { return fn() } finally {
    closeSync(fd)
    try { if (readFileSync(lock, 'utf8') === token) unlinkSync(lock) } catch { /* ignore */ }
  }
}

const result = withLock(() => {
  const data = JSON.parse(readFileSync(registry, 'utf8'))
  const lane = (data.lanes || []).find((l) => l?.slug === slug)
  // Refusals RETURN from inside the lock, so the finally below always releases it.
  if (!lane) return { error: `No lane "${slug}" in ${registry}.` }
  if (lane.role === 'conductor' && !undo) process.stderr.write('Note: this is the conductor; without it, nothing routes requests.\n')
  const today = new Date().toISOString().slice(0, 10)
  let session = null
  if (undo) {
    if (!lane.retired) return { error: `The "${slug}" lane is not retired.` }
    delete lane.retired
  } else {
    if (lane.retired) return { error: `The "${slug}" lane was already retired on ${lane.retired}.` }
    session = lane.sessionId || null
    lane.retired = today
    lane.sessionId = null
  }
  const tmp = `${registry}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  renameSync(tmp, registry)
  return { lane, session, today }
})
if (result.error) await fail(result.error)

// The state file: out of the lanes folder on retire, back on undo. Never overwrite.
const live = path.join(dir, `${slug}.md`)
const kept = path.join(dir, 'retired', `${slug}.md`)
const [from, to] = undo ? [kept, live] : [live, kept]
let moved = 'no state file to move'
if (existsSync(from)) {
  if (existsSync(to)) moved = `${to} already exists: left ${from} where it is`
  else { mkdirSync(path.dirname(to), { recursive: true }); renameSync(from, to); moved = `state file moved to ${to}` }
}

const name = result.lane.name || slug
process.stdout.write(undo
  ? `The "${name}" lane is back: ${moved}. Start its session with "lane: ${slug}" as the first message of a new session.\n`
  : [
      `The "${name}" lane is retired (${result.today}): ${moved}.`,
      result.session
        ? `Its session (${result.session}) is not archived by this script: archive it in the app when you no longer need its history.`
        : 'It had no session.',
      `To undo: node scripts/retire-lane.mjs ${slug} --undo`,
    ].join('\n') + '\n')
