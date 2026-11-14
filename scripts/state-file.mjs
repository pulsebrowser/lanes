/**
 * Checks a lane's state file, so it does not only grow. Used by the lane guard (on `lane: <slug>`, the first
 * message after a clear) and by the status line. Pure reads; never edits the file (the model does, with a reason).
 *
 * A state file has fixed sections (templates/lane-state.md): Now, Waiting for <owner>, Decisions to keep,
 * Done this week, Where things are. This module reports:
 *   - characters and whether the file is over `stateFile.maxChars` of .claude/brain.json (default 12000, about
 *     3000 tokens). Characters, not lines: a cap in lines is dodged by merging bullets into one long line;
 *   - the bullets longer than `stateFile.maxBulletChars` (default 300): one fact per bullet;
 *   - the "Done" items older than `stateFile.doneDays` (default 7): a Done item starts with its date, `- YYYY-MM-DD`;
 *   - days since the "Last updated:" date, when the file has one;
 *   - the "Waiting for <owner>" bullets (0.5.0): what only the owner can decide or approve, so the conductor can
 *     list, for all lanes in one place, what waits for the owner;
 *   - the follow-ups that are due (0.5.0): any bullet with `(due YYYY-MM-DD)` whose date is today or earlier. No
 *     scheduler wakes a lane for them: the status line, the conductor and the lane's own next message show them.
 */
import { readFileSync, existsSync } from 'node:fs'

const DAY = 24 * 60 * 60 * 1000
const DATE = /(\d{4}-\d{2}-\d{2})/
const DUE = /\(due\s+(\d{4}-\d{2}-\d{2})\)/i
const BULLET = /^\s*[-*]\s+/
// Empty only when the WHOLE line is filler: "None.", "_(none)_", "Nothing pending.", "Nothing pending from the last
// release." Anything more is an item: "None yet (approve PR #5)", "Nothing yet, approve PR #5", "None now - merge #7".
const isEmptyLine = (b) => {
  const t = b.replace(/[_*`]/g, '').trim()
  if (/^\(?(?:none|nothing|n\/a|-)(?:\s+(?:for now|right now|now|yet|at the moment))?\)?[.!]?$/i.test(t)) return true
  return /^(?:none|nothing)\s+(?:pending|waiting|open)(?:\s+(?:for now|right now|now|yet|at the moment|from [\w\s-]+))?[.!]?$/i.test(t)
}

/** `now` as the owner's LOCAL calendar date, YYYY-MM-DD: a date in a state file is a day on the owner's clock. */
export function localYmd(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Whole days from a YYYY-MM-DD date to the local date of `now` (0 = today), or null. */
function ageDays(ymd, now) {
  const t = Date.parse(`${ymd}T00:00:00Z`)
  const today = Date.parse(`${localYmd(now)}T00:00:00Z`)
  return Number.isNaN(t) ? null : Math.round((today - t) / DAY)
}

/**
 * @param {string} file  path of <slug>.md
 * @param {{ maxChars?: number, maxBulletChars?: number, doneDays?: number }} limits
 * @param {number} now   ms since epoch (tests pass a fixed one)
 * @returns {null | { chars: number, maxChars: number, overCap: boolean, longBullets: number, maxBulletChars: number,
 *   staleDone: string[], doneDays: number, daysSinceUpdate: number | null, waiting: string[],
 *   due: { date: string, text: string }[] }}
 */
export function inspectStateFile(file, limits = {}, now = Date.now()) {
  if (!file || !existsSync(file)) return null
  const pos = (v, d) => (Number(v) > 0 ? Number(v) : d)
  const maxChars = pos(limits.maxChars, 12000)
  const maxBulletChars = pos(limits.maxBulletChars, 300)
  const doneDays = pos(limits.doneDays, 7)
  const text = readFileSync(file, 'utf8').replace(/\s+$/, '')
  const rows = text.split('\n')
  const chars = [...text].length // code points, so non-Latin text is not counted three times

  let section = ''
  const staleDone = []
  let daysSinceUpdate = null
  let longBullets = 0
  const waiting = []
  const due = []
  for (const row of rows) {
    if (/^\s*[-*]\s/.test(row) && [...row.trim()].length > maxBulletChars) longBullets++
    const head = /^##\s+(.+)$/.exec(row)
    if (head) { section = head[1].trim().toLowerCase(); continue }
    if (daysSinceUpdate === null && /^last updated:/i.test(row)) {
      const d = DATE.exec(row)?.[1]
      if (d) daysSinceUpdate = ageDays(d, now)
    }
    const bullet = BULLET.test(row) ? row.replace(BULLET, '').trim() : ''
    if (bullet && section.startsWith('waiting') && !isEmptyLine(bullet)) waiting.push(bullet)
    const when = bullet && !section.startsWith('done') ? DUE.exec(bullet)?.[1] : null
    if (when) {
      const age = ageDays(when, now)
      if (age !== null && age >= 0) due.push({ date: when, text: bullet })
    }
    if (!section.startsWith('done')) continue
    const item = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\b/.exec(row)
    if (!item) continue
    const age = ageDays(item[1], now)
    if (age !== null && age > doneDays) staleDone.push(row.trim())
  }

  due.sort((a, b) => a.date.localeCompare(b.date))
  return { chars, maxChars, overCap: chars > maxChars, longBullets, maxBulletChars, staleDone, doneDays, daysSinceUpdate, waiting, due }
}
