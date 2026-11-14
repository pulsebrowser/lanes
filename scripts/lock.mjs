/**
 * One writer at a time for a file in the lanes folder (lanes.json, an inbox). Shared by the lane guard's claim,
 * retire-lane.mjs and lane-inbox.mjs (0.5.0; before, each had its own copy).
 *
 * The lock is `<file>.lock`, created with `wx` (only one process can create it) and holding a token. A lock older
 * than 5 s was left by a process that died: it is RENAMED away first, so only one waiter's rename can succeed and two
 * waiters never both delete it and then both take a new lock. A lock is released only by its owner (the token).
 *
 * withLock(file, fn, { tries }) returns fn()'s value, or `{ lockError: true }` when the lock was not had.
 */
import { openSync, writeFileSync, closeSync, readFileSync, renameSync, unlinkSync, statSync } from 'node:fs'

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

export function withLock(file, fn, { tries = 50 } = {}) {
  const lock = `${file}.lock`
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  let fd = null
  for (let i = 0; i < tries && fd === null; i++) {
    try { fd = openSync(lock, 'wx'); writeFileSync(fd, token) } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 5000) {
          const gone = `${lock}.stale.${token}`
          renameSync(lock, gone)
          unlinkSync(gone)
        }
      } catch { /* another waiter got there first */ }
      sleep(10)
    }
  }
  if (fd === null) return { lockError: true }
  try { return fn() } finally {
    closeSync(fd)
    try { if (readFileSync(lock, 'utf8') === token) unlinkSync(lock) } catch { /* ignore */ }
  }
}

/** Write a file whole: a temporary file renamed into place, so no reader ever sees half of it. */
export function writeWhole(file, text) {
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, file)
}
