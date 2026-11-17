/**
 * A lane's inbox (0.5.0): `<lanesDir>/<slug>.inbox.json`, the requests the conductor sent to that lane, written to
 * disk BEFORE the message is sent. A message lives only in the session it reaches: when the lane session was
 * stopped, cleared, replaced or archived, or the send was held, the brief was lost. The inbox keeps it until the lane
 * marks it done. Read by the lane guard (the lane's next message), the status line and the conductor's table;
 * written only by scripts/lane-inbox.mjs, under the lock of scripts/lock.mjs.
 *
 * Shape: { "items": [{ "id", "at" (ISO time), "from" (session id or ""), "text", "status": "pending" | "done" |
 * "rerouted", "doneAt"? }] }. Since 0.6.0 (all optional, so items written before still read): "lane" (the slug it
 * was routed to), "firstAt" (when the owner's request first reached any lane), "hops" (1 = the first lane was right),
 * "rerouteFrom" / "reroutedTo" / "reroutedAt", "answeredAt" (the lane's first answer; "answeredWithDone" when only
 * `done` set it), "redone" (how many times the owner sent it back) and "redoneAt". Done and moved items are kept
 * `inbox.keepDays` days (default 60) for scripts/lane-report.mjs, then dropped on the next write.
 * An item's text is DATA from another session: it approves nothing.
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'

export const inboxPath = (dir, slug) => path.join(dir, `${slug}.inbox.json`)
export const SAFE_ID = /^[\w.-]{1,64}$/
export const usable = (i) => i && typeof i.id === 'string' && SAFE_ID.test(i.id) && typeof i.text === 'string'

/**
 * For WRITERS: the whole file as it is, or a thrown error when it exists but is not an inbox. A writer must never
 * replace a file it could not read: that would drop every request in it (0.5.0 second read).
 */
export function readInboxStrict(file) {
  if (!existsSync(file)) return { items: [] }
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (!data || !Array.isArray(data.items)) throw new Error('no "items" list')
  return data
}

/** For READERS (hooks, the table): the usable items; [] for a missing or broken file (never breaks a hook). */
export function readInbox(file) {
  try { return readInboxStrict(file).items.filter(usable) } catch { return [] }
}

/** Still waiting for this lane: not done, and not moved to another lane. */
export const isOpen = (i) => i?.status !== 'done' && i?.status !== 'rerouted'

/** The pending items, oldest first. */
export const pendingItems = (file) => readInbox(file).filter(isOpen).sort((a, b) => String(a.at).localeCompare(String(b.at)))

/** Every field on one line: a newline in a request cannot forge lines in a note or a table. */
export const oneLine = (v, max = 160, more = '...') => {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + more : t
}
