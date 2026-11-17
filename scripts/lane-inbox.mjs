#!/usr/bin/env node
/**
 * A lane's inbox (0.5.0, see inbox-file.mjs). The conductor adds a request BEFORE it sends the brief; the lane marks
 * when it first answered and when it is done. Since 0.6.0 each item also records how it was routed, for
 * scripts/lane-report.mjs.
 *
 *   node scripts/lane-inbox.mjs add <slug> [--from <session id>] [--id <id>] [--file <path>]   # text on stdin, or --file
 *   node scripts/lane-inbox.mjs list <slug> [--all]
 *   node scripts/lane-inbox.mjs answered <slug> <id>          # the lane's first answer to the owner
 *   node scripts/lane-inbox.mjs done <slug> <id> [<id> ...] --evidence "<text>"
 *   node scripts/lane-inbox.mjs reroute <slug> <id> <to-slug>  # the conductor: wrong lane, move it
 *   node scripts/lane-inbox.mjs redone <slug> <id>             # the owner said the work must be done again
 *
 * `add` prints the id. The same id, or the same text while still pending, is not added twice (the id of the first is
 * printed): a retried send does not make two requests. Refuses an unknown or retired lane.
 * `done` needs a short line of evidence (0.6.1): what shows the work is right, as test output, a screenshot path or
 * a log, or "none: <why>". "Verification means running the change": the line says what was run, and the report counts
 * the requests finished with none.
 * Env: LANE_REGISTRY (tests: path of lanes.json), CLAUDE_PROJECT_DIR (the project).
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadBrainConfig, isSafeSlug } from './brain-config.mjs'
import { withLock, writeWhole } from './lock.mjs'
import { inboxPath, readInbox, readInboxStrict, oneLine, SAFE_ID, usable, isOpen, noneWithoutReason } from './inbox-file.mjs'

const MAX_TEXT = 20000
const MAX_EVIDENCE = 500
const DAY = 24 * 60 * 60 * 1000
const COMMANDS = ['add', 'list', 'answered', 'done', 'reroute', 'redone']
const MAX_HOPS = 4 // a request moved through four lanes goes to the owner, not to a fifth lane
const [cmd, slug, ...rest] = process.argv.slice(2)
const flag = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined }
const fail = (msg) => { process.stderr.write(msg + '\n', () => process.exit(1)); return new Promise(() => {}) }

if (!COMMANDS.includes(cmd) || !isSafeSlug(slug)) {
  await fail('Usage: lane-inbox.mjs add <slug> [--from <id>] [--id <id>] [--file <path>] | list <slug> [--all] | ' +
    'answered <slug> <id> | done <slug> <id>... --evidence "<text>" | reroute <slug> <id> <to-slug> | redone <slug> <id>')
}
const config = loadBrainConfig()
const registry = process.env.LANE_REGISTRY || path.join(config.lanesDir, 'lanes.json')
if (!existsSync(registry)) await fail(`No lanes registry at ${registry}.`)
const dir = path.dirname(registry)
const entry = (s) => (JSON.parse(readFileSync(registry, 'utf8')).lanes || []).find((l) => l?.slug === s)
const lane = entry(slug)
if (!lane) await fail(`No lane "${slug}" in ${registry}.`)
const retiredMsg = (s, l) => `The "${s}" lane was retired on ${l.retired}: route this request elsewhere.`
if (lane.retired && cmd === 'add') await fail(retiredMsg(slug, lane))
const file = inboxPath(dir, slug)
// Done and moved items stay this long, so lane-report.mjs has data (0.6.0; was stateFile.doneDays, 7).
const keepDays = Number(config.inbox?.keepDays) > 0 ? Number(config.inbox.keepDays) : 60
const norm = (t) => String(t).replace(/\s+/g, ' ').trim()
const nowIso = () => new Date().toISOString()
const newId = () => {
  const now = new Date()
  return `${now.toISOString().slice(0, 16).replace(/[-:T]/g, '').replace(/^(\d{8})/, '$1-')}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Change one inbox under its lock; drops done and moved items older than keepDays. Refuses (and writes nothing) when
 * the file exists but is not an inbox. Items it cannot use (a hand edit) are kept as they are, never dropped.
 */
function change(target, fn) {
  const out = withLock(target, () => {
    let data
    try { data = readInboxStrict(target) } catch (e) {
      return { error: `${target} is not a readable inbox (${e?.message || e}): fix or move it; nothing was written.` }
    }
    const result = fn(readInbox(target), data.items)
    if (result?.error) return result
    const cutoff = Date.now() - keepDays * DAY
    const old = (i) => usable(i) && !isOpen(i) && Date.parse(i.doneAt || i.reroutedAt || i.at) < cutoff // odd items are kept
    writeWhole(target, JSON.stringify({ ...data, items: data.items.filter((i) => !old(i)) }, null, 2) + '\n')
    return result
  }, { tries: 200 })
  return out?.lockError ? { error: `${target} is locked by another writer; try again.` } : out
}

/** Re-read under the lock: a retire between the first check and the write must win. */
function liveLane(s) {
  let l = null
  try { l = entry(s) } catch { return { error: `${registry} could not be read; nothing was written.` } }
  if (!l || l.retired) return { error: l ? retiredMsg(s, l) : `No lane "${s}" in ${registry}.` }
  return { lane: l }
}

/** Set fields on ONE open-or-done item by id; `fn(item)` returns an error string, or nothing to save. */
function update(id, fn, target = file) {
  if (!id || !SAFE_ID.test(id)) return { error: 'Name the id of the request.' }
  return change(target, (_items, raw) => {
    const item = raw.find((i) => usable(i) && i.id === id && i.status !== 'rerouted')
    if (!item) {
      const moved = raw.find((i) => usable(i) && i.id === id && i.status === 'rerouted')
      return { error: moved ? `${id} was moved to ${isSafeSlug(moved.reroutedTo) ? moved.reroutedTo : 'another lane'}: it is not this lane's any more.` : `Not in the ${slug} inbox: ${id}.` }
    }
    const err = fn(item)
    return err ? { error: err } : { item }
  })
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
  const r = change(file, (items, raw) => {
    const live = liveLane(slug)
    if (live.error) return live
    const same = items.find((i) => isOpen(i) && ((wantId && i.id === wantId) || norm(i.text) === norm(text)))
    if (same) return { id: same.id, again: true }
    if (wantId && raw.some((i) => i?.id === wantId)) {
      return { error: `The id ${wantId} is already used (a request already done, or a hand-edited item): give this one another id.` }
    }
    const id = wantId || newId()
    const at = nowIso()
    raw.push({ id, at, firstAt: at, from: oneLine(flag('--from') || '', 80), text, status: 'pending', lane: slug, hops: 1 })
    return { id, again: false }
  })
  if (r.error) await fail(r.error)
  process.stdout.write(r.again ? `${r.id} (already in the inbox of ${slug}; not added twice)\n` : `${r.id}\n`)
} else if (cmd === 'list') {
  const all = rest.includes('--all')
  const items = readInbox(file).filter((i) => all || isOpen(i))
  if (!items.length) process.stdout.write(`The ${slug} inbox has no ${all ? '' : 'pending '}requests.\n`)
  for (const i of items) {
    // The text is quoted line by line ("> "), so a line in it can never read as another request's header.
    const quoted = i.text.split('\n').map((l) => `> ${l}`).join('\n')
    const extra = [
      i.hops > 1 ? `hop ${Number(i.hops)}` : '',
      i.status === 'rerouted' && isSafeSlug(i.reroutedTo) ? `moved to ${i.reroutedTo}` : '',
      Number(i.redone) > 0 ? `redone ${Number(i.redone)}x` : '',
      i.status === 'done' && i.evidence ? `evidence: ${oneLine(i.evidence, 120)}` : '',
    ].filter(Boolean).join(', ')
    process.stdout.write(`## ${i.id} (${oneLine(i.status, 10)}, ${oneLine(i.at, 16, '').replace('T', ' ')} UTC${i.from ? `, from ${oneLine(i.from, 80)}` : ''}${extra ? `, ${extra}` : ''})\n${quoted}\n\n`)
  }
} else if (cmd === 'answered') {
  const r = update(rest[0], (item) => { if (!item.answeredAt) item.answeredAt = nowIso() })
  if (r.error) await fail(r.error)
  process.stdout.write(`Answered: ${r.item.id} (${r.item.answeredAt}).\n`)
} else if (cmd === 'done') {
  // `--evidence <text>` or `--evidence=<text>`; a word after any `--evidence` is never an id.
  const values = []
  const ids = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a === '--evidence') { values.push(rest[i + 1] ?? ''); i++ } else if (a.startsWith('--evidence=')) values.push(a.slice(11))
    else if (!a.startsWith('--')) ids.push(a)
  }
  if (!ids.length) await fail('Name the id(s) to mark done.')
  if (values.length > 1) await fail('Give --evidence once.')
  const evidence = String(values[0] ?? '').replace(/\s+/g, ' ').trim()
  if (!evidence) {
    await fail('Say what shows it is done: --evidence "<test output, a screenshot path, a log>", ' +
      'or --evidence "none: <why>" when nothing was run (a question answered, a decision written down).')
  }
  if (noneWithoutReason(evidence)) {
    await fail('"none" needs its reason: --evidence "none: <why>".')
  }
  if ([...evidence].length > MAX_EVIDENCE) await fail(`The evidence is over ${MAX_EVIDENCE} characters: name a file or a log path instead.`)
  const r = change(file, (_items, raw) => {
    const found = []
    for (const i of raw) {
      if (!usable(i) || !ids.includes(i.id) || !isOpen(i)) continue
      i.status = 'done'
      i.doneAt = nowIso()
      i.evidence = evidence
      // No `answered` before `done`: the answer time is the done time, and the report says so.
      if (!i.answeredAt) { i.answeredAt = i.doneAt; i.answeredWithDone = true }
      found.push(i.id)
    }
    // A request the conductor moved is not this lane's any more: say where it went, and fail (0.6.0 re-read).
    const moved = raw.filter((i) => usable(i) && ids.includes(i.id) && i.status === 'rerouted' && !found.includes(i.id))
      .map((i) => `${i.id} (moved to ${isSafeSlug(i.reroutedTo) ? i.reroutedTo : 'another lane'})`)
    return { found, moved, missing: ids.filter((id) => !found.includes(id) && !raw.some((i) => i?.id === id)) }
  })
  if (r.error) await fail(r.error)
  if (r.moved.length) process.stderr.write(`Not this lane's any more: ${r.moved.join(', ')}. Do not do that work here.\n`)
  if (r.missing.length) process.stderr.write(`Not in the ${slug} inbox: ${r.missing.join(', ')}.\n`)
  process.stdout.write(`Marked done: ${r.found.join(', ') || 'none'}.\n`)
  if ((r.missing.length || r.moved.length) && !r.found.length) process.exitCode = 1
} else if (cmd === 'reroute') {
  const [id, to] = rest
  if (!id || !SAFE_ID.test(id)) await fail('Name the id of the request.')
  if (!isSafeSlug(to) || to === slug) await fail('Name the lane to move it to (another lane\'s slug).')
  // A retired lane's inbox is in retired/ (retire-lane.mjs): its pending requests are moved out from there.
  const sourceFile = lane.retired ? inboxPath(path.join(dir, 'retired'), slug) : file
  // 1. Claim the request under the SOURCE lock: from here on it is no longer open there, so a `done` that races
  //    this move fails instead of leaving the request open in two lanes.
  let claimed = null
  const r1 = update(id, (item) => {
    if (!isOpen(item)) return `No open request ${id} in the ${slug} inbox.`
    const hops = Number(item.hops) > 0 ? Number(item.hops) : 1
    if (hops >= MAX_HOPS) return `${id} has been through ${hops} lanes: ask the owner where it belongs instead of moving it again.`
    claimed = { ...item, hops }
    item.status = 'rerouted'
    item.reroutedTo = to
    item.reroutedAt = nowIso()
  }, sourceFile)
  if (r1.error) await fail(r1.error)
  // 2. Add it to the target. The id stays, unless the target still holds it (a request moved back: A to B to A);
  //    then the new copy gets `<id>.h<hops>`, so the first copy keeps its own record.
  const hops = claimed.hops + 1
  let added
  // Any failure here, a clean refusal or a crash (a full disk), takes the put-back below: never open in no lane.
  try { added = change(inboxPath(dir, to), (_items, raw) => {
    const live = liveLane(to)
    if (live.error) return live
    let newId = id
    if (raw.some((i) => i?.id === newId)) { const suffix = `.h${hops}`; newId = `${id.slice(0, 64 - suffix.length)}${suffix}` }
    if (raw.some((i) => i?.id === newId)) return { error: `The ${to} inbox already has a request ${newId}.` }
    raw.push({
      id: newId, at: nowIso(), firstAt: claimed.firstAt || claimed.at, from: claimed.from || '', text: claimed.text,
      status: 'pending', lane: to, hops, rerouteFrom: slug,
    })
    return { newId }
  }) } catch (e) { added = { error: `Could not write the ${to} inbox (${e?.message || e}).` } }
  if (added.error) {
    // 3. The target refused: give the request back to the source, as it was.
    const back = change(sourceFile, (_items, raw) => {
      const item = raw.find((i) => usable(i) && i.id === id && i.status === 'rerouted' && i.reroutedTo === to)
      if (!item) return { error: 'gone' }
      item.status = claimed.status || 'pending'
      delete item.reroutedTo
      delete item.reroutedAt
      return {}
    })
    await fail(`${added.error}${back.error ? ` And ${id} could not be put back as open in ${slug}: open it there by hand.` : ` ${id} is still open in ${slug}.`}`)
  }
  process.stdout.write(`Moved ${id} from ${slug} to ${to}${added.newId !== id ? ` as ${added.newId}` : ''}. ` +
    `Send the brief to the ${to} lane now, with the inbox id ${added.newId}.\n`)
} else if (cmd === 'redone') {
  const r = update(rest[0], (item) => {
    if (item.status !== 'done') return `${item.id} is not done: only finished work can be redone.`
    item.redone = (Number(item.redone) > 0 ? Number(item.redone) : 0) + 1
    item.redoneAt = nowIso()
    item.status = 'pending'
  })
  if (r.error) await fail(r.error)
  process.stdout.write(`Reopened ${r.item.id} (redone ${r.item.redone}x). Mark it done again when the new work is finished.\n`)
}
