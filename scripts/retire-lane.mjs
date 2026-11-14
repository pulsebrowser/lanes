#!/usr/bin/env node
/**
 * Retire a lane that is no longer needed (0.4.1).
 *
 *   node scripts/retire-lane.mjs <slug>            # retire
 *   node scripts/retire-lane.mjs <slug> --undo     # bring it back
 *
 * Its inbox (`<slug>.inbox.json`, 0.5.0) moves with the state file; pending requests in it are named.
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
import { readFileSync, renameSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { withLock, writeWhole } from './lock.mjs'
import { pendingItems, inboxPath } from './inbox-file.mjs'
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

const locked = withLock(registry, () => {
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
  writeWhole(registry, JSON.stringify(data, null, 2) + '\n')
  return { lane, session, today }
}, { tries: 200 })
const result = locked.lockError ? { error: 'lanes.json is locked by another writer; try again.' } : locked
if (result.error) await fail(result.error)

// The state file and the inbox (0.5.0): out of the lanes folder on retire, back on undo. Never overwrite.
function move(file, what) {
  const live = path.join(dir, file)
  const kept = path.join(dir, 'retired', file)
  const [from, to] = undo ? [kept, live] : [live, kept]
  if (!existsSync(from)) return what === 'state file' ? 'no state file to move' : ''
  if (existsSync(to)) return `${to} already exists: left ${from} where it is`
  mkdirSync(path.dirname(to), { recursive: true })
  renameSync(from, to)
  return `${what} moved to ${to}`
}
// The inbox moves under ITS lock: an add that holds the lock (and already saw the lane not retired) finishes first,
// and any add after it re-reads lanes.json under the same lock and refuses.
const inboxMove = withLock(inboxPath(dir, slug), () => move(`${slug}.inbox.json`, 'inbox'), { tries: 200 })
const moved = [move(`${slug}.md`, 'state file'), inboxMove.lockError ? `the inbox was locked: move ${slug}.inbox.json by hand` : inboxMove]
  .filter(Boolean).join('; ')
try { rmSync(path.join(dir, `${slug}.seen.json`), { force: true }) } catch { /* only a cache of notes shown */ }
const pendingLeft = undo ? 0 : pendingItems(path.join(dir, 'retired', `${slug}.inbox.json`)).length

const name = result.lane.name || slug
process.stdout.write(undo
  ? `The "${name}" lane is back: ${moved}. Start its session with "lane: ${slug}" as the first message of a new session.\n`
  : [
      `The "${name}" lane is retired (${result.today}): ${moved}.`,
      ...(pendingLeft ? [`Its inbox had ${pendingLeft} pending request(s): route them to another lane, or tell the owner.`] : []),
      result.session
        ? `Its session (${result.session}) is not archived by this script: archive it in the app when you no longer need its history.`
        : 'It had no session.',
      `To undo: node scripts/retire-lane.mjs ${slug} --undo`,
    ].join('\n') + '\n')
