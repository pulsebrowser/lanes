#!/usr/bin/env node
/**
 * The routing table for the conductor (skill `lanes:conductor`, 0.4.0). Prints, for each work lane: its slug, name,
 * description, session id (or "no session yet"), keywords, and the first lines of the "Now" section of its state
 * file, so the conductor knows what each lane does AND what it is doing today. Code gives the facts; the model
 * picks the lane.
 *
 * Since 0.5.0 it also prints, per lane, what waits for the owner (the "Waiting for" section), the follow-ups that are
 * due, and the requests still pending in the lane's inbox, with a count of all of them at the top.
 *
 * The conductor lane itself (`"role": "conductor"` in lanes.json) is listed apart: it routes, it does not take work.
 * It fails quiet: no registry prints one line saying so, and the exit code is always 0.
 *
 * Env: LANE_REGISTRY (tests: path of lanes.json), CLAUDE_PROJECT_DIR (the project).
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadBrainConfig, isSafeSlug } from './brain-config.mjs'
import { inspectStateFile } from './state-file.mjs'
import { inboxPath, pendingItems } from './inbox-file.mjs'

const NOW_LINES = 3
// Every printed field on one line: a newline in a description or a state file cannot forge a lane block.
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const cut = (t) => (t.length > 160 ? t.slice(0, 160) + '...' : t)

/** The first bullets of the "## Now" section of a state file. */
function nowLines(file) {
  try { return readNow(file) } catch { return [] } // a broken state file loses its own lines, never the table
}

function readNow(file) {
  if (!existsSync(file)) return []
  const out = []
  let inNow = false
  for (const row of readFileSync(file, 'utf8').split('\n')) {
    const head = /^##\s+(.+)$/.exec(row)
    if (head) { inNow = head[1].trim().toLowerCase().startsWith('now'); continue }
    if (inNow && /^\s*[-*]\s+\S/.test(row)) {
      out.push(cut(clean(row.replace(/^\s*[-*]\s+/, ''))))
      if (out.length >= NOW_LINES) break
    }
  }
  return out
}

function main() {
  const config = loadBrainConfig()
  const registry = process.env.LANE_REGISTRY || path.join(config.lanesDir, 'lanes.json')
  if (!existsSync(registry)) return `No lanes registry at ${registry}. Set up lanes first (skill lanes:lanes).`
  const data = JSON.parse(readFileSync(registry, 'utf8'))
  const lanes = (Array.isArray(data?.lanes) ? data.lanes : []).filter((l) => isSafeSlug(l?.slug) && !l.retired)
  const dir = path.dirname(registry)
  const conductor = lanes.find((l) => l.role === 'conductor' && l.sessionId) || lanes.find((l) => l.role === 'conductor')
  const work = lanes.filter((l) => l.role !== 'conductor')

  const owner = clean(config.owner) || 'the owner'
  const lines = [`# Lanes (${work.length}), from ${registry}`, '']
  const counts = { waiting: 0, due: 0, inbox: 0, waitLanes: new Set() }
  const body = []
  for (const l of work) {
    let info = null
    try { info = inspectStateFile(path.join(dir, `${l.slug}.md`), config.stateFile) } catch { info = null }
    let pending = []
    try { pending = pendingItems(inboxPath(dir, l.slug)) } catch { pending = [] }
    const waiting = (info?.waiting || []).map((t) => cut(clean(t)))
    const due = (info?.due || []).map((d) => cut(clean(d.text)))
    counts.waiting += waiting.length; counts.due += due.length; counts.inbox += pending.length
    if (waiting.length) counts.waitLanes.add(l.slug)
    body.push(`## ${l.slug}: ${clean(l.name) || l.slug}`)
    body.push(`- does: ${clean(l.description) || '(no description: route by name and keywords, and ask when unsure)'}`)
    body.push(`- session: ${clean(l.sessionId) || 'no session yet (the owner must start it with "lane: ' + l.slug + '")'}`)
    if (Array.isArray(l.keywords) && l.keywords.length) body.push(`- keywords: ${l.keywords.slice(0, 15).map(clean).join(', ')}`)
    const now = nowLines(path.join(dir, `${l.slug}.md`))
    if (now.length) body.push(`- now: ${now.join(' | ')}`)
    if (waiting.length) body.push(`- waiting for ${owner}: ${waiting.slice(0, 5).join(' | ')}${waiting.length > 5 ? ` | ...and ${waiting.length - 5} more` : ''}`)
    if (due.length) body.push(`- due: ${due.slice(0, 5).join(' | ')}`)
    if (pending.length) body.push(`- inbox: ${pending.length} pending, oldest ${clean(pending[0].at).slice(0, 10)} (${pending.slice(0, 5).map((i) => clean(i.id)).join(', ')})`)
    body.push('')
  }
  const n = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`
  lines.push(
    counts.waiting
      ? `Waiting for ${owner}: ${n(counts.waiting, 'item')} in ${n(counts.waitLanes.size, 'lane')}.`
      : `Nothing in any lane's "Waiting for" section.`,
    `Due follow-ups: ${counts.due}. Requests pending in lane inboxes: ${counts.inbox}.`,
    '',
    ...body,
  )
  const retired = (Array.isArray(data?.lanes) ? data.lanes : []).filter((l) => l?.retired).map((l) => clean(l.name || l.slug))
  if (retired.length) lines.push(`Retired (route nothing there): ${retired.join(', ')}.`, '')
  lines.push(conductor
    ? `Conductor: ${clean(conductor.name) || conductor.slug}, session ${clean(conductor.sessionId) || 'not claimed yet'}.`
    : 'No conductor lane in the registry (add one with "role": "conductor").')
  return lines.join('\n')
}

let out = ''
try { out = main() } catch (e) { out = `Could not read the lanes registry: ${e?.message || e}` }
process.stdout.write(out + '\n')
process.exit(0)
