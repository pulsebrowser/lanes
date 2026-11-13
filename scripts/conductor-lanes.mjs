#!/usr/bin/env node
/**
 * The routing table for the conductor (skill `lanes:conductor`, 0.4.0). Prints, for each work lane: its slug, name,
 * description, session id (or "no session yet"), keywords, and the first lines of the "Now" section of its state
 * file, so the conductor knows what each lane does AND what it is doing today. Code gives the facts; the model
 * picks the lane.
 *
 * The conductor lane itself (`"role": "conductor"` in lanes.json) is listed apart: it routes, it does not take work.
 * It fails quiet: no registry prints one line saying so, and the exit code is always 0.
 *
 * Env: LANE_REGISTRY (tests: path of lanes.json), CLAUDE_PROJECT_DIR (the project).
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadBrainConfig, isSafeSlug } from './brain-config.mjs'

const NOW_LINES = 3
// Every printed field on one line: a newline in a description or a state file cannot forge a lane block.
const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()

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
      const text = clean(row.replace(/^\s*[-*]\s+/, ''))
      out.push(text.length > 160 ? text.slice(0, 160) + '...' : text)
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
  const lanes = (Array.isArray(data?.lanes) ? data.lanes : []).filter((l) => isSafeSlug(l?.slug))
  const dir = path.dirname(registry)
  const conductor = lanes.find((l) => l.role === 'conductor' && l.sessionId) || lanes.find((l) => l.role === 'conductor')
  const work = lanes.filter((l) => l.role !== 'conductor')

  const lines = [`# Lanes (${work.length}), from ${registry}`, '']
  for (const l of work) {
    lines.push(`## ${l.slug}: ${clean(l.name) || l.slug}`)
    lines.push(`- does: ${clean(l.description) || '(no description: route by name and keywords, and ask when unsure)'}`)
    lines.push(`- session: ${clean(l.sessionId) || 'no session yet (the owner must start it with "lane: ' + l.slug + '")'}`)
    if (Array.isArray(l.keywords) && l.keywords.length) lines.push(`- keywords: ${l.keywords.slice(0, 15).map(clean).join(', ')}`)
    const now = nowLines(path.join(dir, `${l.slug}.md`))
    if (now.length) lines.push(`- now: ${now.join(' | ')}`)
    lines.push('')
  }
  lines.push(conductor
    ? `Conductor: ${clean(conductor.name) || conductor.slug}, session ${clean(conductor.sessionId) || 'not claimed yet'}.`
    : 'No conductor lane in the registry (add one with "role": "conductor").')
  return lines.join('\n')
}

let out = ''
try { out = main() } catch (e) { out = `Could not read the lanes registry: ${e?.message || e}` }
process.stdout.write(out + '\n')
process.exit(0)
