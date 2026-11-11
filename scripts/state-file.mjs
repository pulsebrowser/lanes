/**
 * Checks a lane's state file, so it does not only grow. Used by the lane guard (on `lane: <slug>`, the first
 * message after a clear) and by the status line. Pure reads; never edits the file (the model does, with a reason).
 *
 * A state file has fixed sections (templates/lane-state.md): Now, Waiting for <owner>, Decisions to keep,
 * Done this week, Where things are. This module reports:
 *   - lines and whether the file is over `stateFile.maxLines` of .claude/brain.json (default 150);
 *   - the "Done" items older than `stateFile.doneDays` (default 7): a Done item starts with its date, `- YYYY-MM-DD`;
 *   - days since the "Last updated:" date, when the file has one.
 */
import { readFileSync, existsSync } from 'node:fs'

const DAY = 24 * 60 * 60 * 1000
const DATE = /(\d{4}-\d{2}-\d{2})/

/** Days between a YYYY-MM-DD date and `now`, or null. */
function ageDays(ymd, now) {
  const t = Date.parse(`${ymd}T00:00:00Z`)
  return Number.isNaN(t) ? null : Math.floor((now - t) / DAY)
}

/**
 * @param {string} file  path of <slug>.md
 * @param {{ maxLines?: number, doneDays?: number }} limits
 * @param {number} now   ms since epoch (tests pass a fixed one)
 * @returns {null | { lines: number, maxLines: number, overCap: boolean, staleDone: string[], doneDays: number, daysSinceUpdate: number | null }}
 */
export function inspectStateFile(file, limits = {}, now = Date.now()) {
  if (!file || !existsSync(file)) return null
  const maxLines = Number(limits.maxLines) > 0 ? Number(limits.maxLines) : 150
  const doneDays = Number(limits.doneDays) > 0 ? Number(limits.doneDays) : 7
  const text = readFileSync(file, 'utf8')
  const rows = text.replace(/\n+$/, '').split('\n')

  let section = ''
  const staleDone = []
  let daysSinceUpdate = null
  for (const row of rows) {
    const head = /^##\s+(.+)$/.exec(row)
    if (head) { section = head[1].trim().toLowerCase(); continue }
    if (daysSinceUpdate === null && /^last updated:/i.test(row)) {
      const d = DATE.exec(row)?.[1]
      if (d) daysSinceUpdate = ageDays(d, now)
    }
    if (!section.startsWith('done')) continue
    const item = /^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\b/.exec(row)
    if (!item) continue
    const age = ageDays(item[1], now)
    if (age !== null && age > doneDays) staleDone.push(row.trim())
  }

  return { lines: rows.length, maxLines, overCap: rows.length > maxLines, staleDone, doneDays, daysSinceUpdate }
}
