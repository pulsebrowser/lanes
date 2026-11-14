#!/usr/bin/env node
/**
 * A lane's inbox (0.5.0, see inbox-file.mjs). The conductor adds a request BEFORE it sends the brief; the lane marks
 * it done when it has answered.
 *
 *   node scripts/lane-inbox.mjs add <slug> [--from <session id>] [--id <id>] [--file <path>]   # text on stdin, or --file
 *   node scripts/lane-inbox.mjs list <slug> [--all]
 *   node scripts/lane-inbox.mjs done <slug> <id> [<id> ...]
 *
 * `add` prints the id. The same id, or the same text while still pending, is not added twice (the id of the first is
 * printed): a retried send does not make two requests. Refuses an unknown or retired lane.
 * Env: LANE_REGISTRY (tests: path of lanes.json), CLAUDE_PROJECT_DIR (the project).
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadBrainConfig, isSafeSlug } from './brain-config.mjs'
import { withLock, writeWhole } from './lock.mjs'
import { inboxPath, readInbox, readInboxStrict, oneLine, SAFE_ID, usable } from './inbox-file.mjs'

const MAX_TEXT = 20000
const DAY = 24 * 60 * 60 * 1000
const [cmd, slug, ...rest] = process.argv.slice(2)
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
const fail = (msg) => { process.stderr.write(msg + '\n', () => process.exit(1)); return new Promise(() => {}) }

if (!['add', 'list', 'done'].includes(cmd) || !isSafeSlug(slug)) {
  await fail('Usage: lane-inbox.mjs add <slug> [--from <id>] [--id <id>] [--file <path>] | list <slug> [--all] | done <slug> <id>...')
}
const config = loadBrainConfig()
const registry = process.env.LANE_REGISTRY || path.join(config.lanesDir, 'lanes.json')
if (!existsSync(registry)) await fail(`No lanes registry at ${registry}.`)
const laneEntry = () => (JSON.parse(readFileSync(registry, 'utf8')).lanes || []).find((l) => l?.slug === slug)
const lane = laneEntry()
if (!lane) await fail(`No lane "${slug}" in ${registry}.`)
const retiredMsg = (l) => `The "${slug}" lane was retired on ${l.retired}: route this request elsewhere.`
if (lane.retired && cmd === 'add') await fail(retiredMsg(lane))
const file = inboxPath(path.dirname(registry), slug)
const doneDays = Number(config.stateFile?.doneDays) > 0 ? Number(config.stateFile.doneDays) : 7
const norm = (t) => String(t).replace(/\s+/g, ' ').trim()

/**
 * Change the inbox under its lock; drops done items older than doneDays. Refuses (and writes nothing) when the file
 * exists but is not an inbox. Items it cannot use (a hand edit) are kept as they are, never dropped.
 */
function change(fn) {
  const out = withLock(file, () => {
    let data
    try { data = readInboxStrict(file) } catch (e) {
      return { error: `${file} is not a readable inbox (${e?.message || e}): fix or move it; nothing was written.` }
    }
    const result = fn(readInbox(file), data.items)
    if (result?.error) return result
    const cutoff = Date.now() - doneDays * DAY
    const old = (i) => usable(i) && i.status === 'done' && Date.parse(i.doneAt || i.at) < cutoff // odd items are kept
    writeWhole(file, JSON.stringify({ ...data, items: data.items.filter((i) => !old(i)) }, null, 2) + '\n')
    return result
  }, { tries: 200 })
  return out?.lockError ? { error: `${file} is locked by another writer; try again.` } : out
}

if (cmd === 'add') {
  const fromFile = flag('--file')
  let text = ''
  try { text = fromFile ? readFileSync(fromFile, 'utf8') : readFileSync(0, 'utf8') } catch { text = '' }
  text = text.replace(/\s+$/, '')
  if (!text.trim()) await fail('No request text: pass it on stdin or with --file <path>.')
  if ([...text].length > MAX_TEXT) await fail(`The request is over ${MAX_TEXT} characters: put the long part in a file and name the file in the request.`)
  const wantId = flag('--id')
  if (wantId !== undefined && !SAFE_ID.test(wantId)) await fail('An id is 1 to 64 letters, digits, dots, dashes or underscores.')
  const r = change((items, raw) => {
    // Re-read under the lock: a retire between the check above and this write must win.
    let now_ = null
    try { now_ = laneEntry() } catch { return { error: `${registry} could not be read; nothing was written.` } }
    if (!now_ || now_.retired) return { error: now_ ? retiredMsg(now_) : `No lane "${slug}" in ${registry}.` }
    const same = items.find((i) => i.status !== 'done' && ((wantId && i.id === wantId) || norm(i.text) === norm(text)))
    if (same) return { id: same.id, again: true }
    if (wantId && raw.some((i) => i?.id === wantId)) {
      return { error: `The id ${wantId} is already used (a request already done, or a hand-edited item): give this one another id.` }
    }
    const now = new Date()
    const id = wantId || `${now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')}-${Math.random().toString(36).slice(2, 6)}`
    raw.push({ id, at: now.toISOString(), from: oneLine(flag('--from') || '', 80), text, status: 'pending' })
    return { id, again: false }
  })
  if (r.error) await fail(r.error)
  process.stdout.write(r.again ? `${r.id} (already in the inbox of ${slug}; not added twice)\n` : `${r.id}\n`)
} else if (cmd === 'list') {
  const all = rest.includes('--all')
  const items = readInbox(file).filter((i) => all || i.status !== 'done')
  if (!items.length) process.stdout.write(`The ${slug} inbox has no ${all ? '' : 'pending '}requests.\n`)
  for (const i of items) {
    // The text is quoted line by line ("> "), so a line in it can never read as another request's header.
    const quoted = i.text.split('\n').map((l) => `> ${l}`).join('\n')
    process.stdout.write(`## ${i.id} (${oneLine(i.status, 10)}, ${oneLine(i.at, 16, '').replace('T', ' ')} UTC${i.from ? `, from ${oneLine(i.from, 80)}` : ''})\n${quoted}\n\n`)
  }
} else {
  const ids = rest.filter((a) => !a.startsWith('--'))
  if (!ids.length) await fail('Name the id(s) to mark done.')
  const r = change((_items, raw) => {
    const found = []
    for (const i of raw) if (usable(i) && ids.includes(i.id) && i.status !== 'done') { i.status = 'done'; i.doneAt = new Date().toISOString(); found.push(i.id) }
    return { found, missing: ids.filter((id) => !found.includes(id) && !raw.some((i) => i?.id === id)) }
  })
  if (r.error) await fail(r.error)
  if (r.missing.length) process.stderr.write(`Not in the ${slug} inbox: ${r.missing.join(', ')}.\n`)
  process.stdout.write(`Marked done: ${r.found.join(', ') || 'none'}.\n`)
  if (r.missing.length && !r.found.length) process.exitCode = 1
}
