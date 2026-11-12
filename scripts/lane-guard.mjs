#!/usr/bin/env node
/**
 * Lane guard. A Claude Code UserPromptSubmit hook.
 *
 * Work is split into LANES (one per kind of work). Each lane keeps ONE long-lived session and one state file.
 * This hook stops the FIRST message of a new session when the message matches a lane that already has a session,
 * and names that session. Later messages of a session always pass.
 *
 * The registry (lanes.json) and the state files (<slug>.md) live outside the repository, in `lanesDir` of
 * .claude/brain.json (default ~/.claude/lanes/<project folder>). Session ids are local to one machine and the state
 * changes every day, so neither belongs in git.
 *
 * Prefixes on the first message:
 *   new:          start a new session anyway.
 *   lane: <name>  this IS that lane's session (after a /clear). The hook passes and tells the model to read
 *                 the lane's state file first, then to trim it (the trim on clear, 0.3.0): delete finished work
 *                 and old Done items, move rules that outlive the work out, and rewrite the file, never append.
 *                 In the desktop app it also CLAIMS the lane (0.3.2): lanes.json gets this session's id, so a
 *                 replaced or restored session never leaves a stale id behind, and it tells the model to turn off
 *                 this session's auto_archive_on_close switch (a lane is never archived).
 *
 * Exempt: scheduled task runs (their prompt is the task's SKILL.md body). It matches keywords in code, no model
 * call. It fails OPEN: any error of its own lets the message through.
 *
 * Input: hook JSON on stdin ({ prompt, transcript_path, session_id }). Exit 2 blocks; stderr is shown to the user.
 * Env (tests): LANE_REGISTRY (path of lanes.json), LANE_TASKS_DIR (scheduled tasks folder).
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, renameSync, openSync, readSync, closeSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { loadBrainConfig, escapeRegExp as escape, isSafeSlug } from './brain-config.mjs'
import { inspectStateFile } from './state-file.mjs'

const CONFIG = loadBrainConfig()
const REGISTRY = process.env.LANE_REGISTRY || path.join(CONFIG.lanesDir, 'lanes.json')
const TASKS_DIR = process.env.LANE_TASKS_DIR || CONFIG.scheduledTasksDir

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()

const HEAD_BYTES = 256 * 1024
// Lines the app writes as a user turn that the person did not type. Pasted HTML that starts with `<` is still typed.
const WRAPPERS = /^<(?:command-|local-command|system-reminder|bash-|task-notification|user-prompt-submit-hook|cross-session-message|agent-message)/

/** The typed prompts at the start of a transcript (JSONL), read from its first HEAD_BYTES only. */
function typedPrompts(transcriptPath) {
  const fd = openSync(transcriptPath, 'r')
  const buf = Buffer.alloc(HEAD_BYTES)
  const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
  closeSync(fd)
  const out = []
  for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
    if (!line.includes('"type":"user"')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'user' || e.isMeta || e.isCompactSummary) continue
    const c = e.message?.content
    if (Array.isArray(c) && c.some((p) => p?.type === 'tool_result')) continue
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : ''
    if (!text || WRAPPERS.test(text.trimStart())) continue
    out.push(norm(text))
  }
  return { prompts: out, truncated: n === HEAD_BYTES }
}

/**
 * True when the session has no earlier typed prompt (a new or just-cleared session). The current prompt may already
 * be the last line of the transcript, so ONE copy of it at the end is not an earlier prompt; any other typed prompt is,
 * even the same words sent twice. Reads the head of the transcript only: a long session is cheap to check.
 */
function isFirstPrompt(transcriptPath, prompt) {
  if (!transcriptPath || !existsSync(transcriptPath)) return true
  const { prompts, truncated } = typedPrompts(transcriptPath)
  if (truncated) return false // more than HEAD_BYTES of transcript: not a new session
  if (prompts.length && prompts[prompts.length - 1] === norm(prompt)) prompts.pop()
  return prompts.length === 0
}

/** True when the prompt is a scheduled task's own instructions. */
function isScheduledTask(prompt) {
  if (!existsSync(TASKS_DIR)) return false
  const p = norm(prompt)
  for (const dir of readdirSync(TASKS_DIR)) {
    const f = path.join(TASKS_DIR, dir, 'SKILL.md')
    if (!existsSync(f)) continue
    const body = norm(readFileSync(f, 'utf8').replace(/^---[\s\S]*?\n---\n/, ''))
    // Both sides at least 40 characters: a short prompt like "deploy" is not a task just because a task says "deploy".
    const head = body.slice(0, 120)
    if (head.length >= 40 && p.length >= 40 && (p.includes(head) || body.includes(p.slice(0, 120)))) return true
  }
  return false
}

function score(prompt, lane) {
  const p = norm(prompt)
  return (lane.keywords || []).filter((k) => new RegExp(`(^|[^a-z0-9])${escape(norm(k))}($|[^a-z0-9])`).test(p))
}

/**
 * The claim: `lane: <slug>` in the desktop app makes THIS session the lane's session in lanes.json. Before 0.3.2 the
 * id was copied by hand and went stale when a session was replaced (the guard then pointed at an archived session).
 * Two sessions can claim at the same moment, so the write holds a lock file, RE-READS lanes.json under it, changes
 * only this lane, and renames a temporary file into place (no reader sees half a file, no claim is lost).
 * Returns the old id, or null when nothing changed or the lock was not had (the claim is then skipped: fail open).
 */
function claimLane(registry, slug, me) {
  if (!me) return null
  const lock = `${registry}.lock`
  const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  let fd = null
  for (let i = 0; i < 50 && fd === null; i++) {
    try { fd = openSync(lock, 'wx') } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) unlinkSync(lock) } catch { /* gone already */ }
      sleep(10)
    }
  }
  if (fd === null) return null
  try {
    const data = JSON.parse(readFileSync(registry, 'utf8'))
    const lane = (data.lanes || []).find((l) => l?.slug === slug)
    if (!lane || lane.sessionId === me) return null
    const old = lane.sessionId || 'none'
    lane.sessionId = me
    const tmp = `${registry}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
    renameSync(tmp, registry)
    return old
  } finally {
    closeSync(fd)
    try { unlinkSync(lock) } catch { /* ignore */ }
  }
}

/**
 * Which lane `lane: <words>` names: the slug (or its words, `pulse-hosted` = `pulse hosted`) or the name, as whole
 * words at the start. The LONGEST match wins, so `lane: web-api` is never the lane `web`. Lanes with an empty or
 * unsafe slug (one that could leave the lanes folder, like `../x`) are skipped.
 */
function findLane(lanes, words) {
  const want = norm(String(words).replace(/[,.;:!?()]/g, ' ')).split(' ').slice(0, 6).join(' ') // `lane: web-api, go`
  const wantWords = want.replace(/-/g, ' ')
  const starts = (text, key) => key && (text === key || text.startsWith(key + ' '))
  let best = null
  let bestLen = 0
  for (const l of lanes) {
    if (!isSafeSlug(l?.slug)) continue
    const keys = [norm(l.slug), norm(l.slug).replace(/-/g, ' '), l.name ? norm(l.name) : '']
    for (const k of keys) {
      const hit = starts(want, k) || starts(wantWords, k.replace(/-/g, ' '))
      if (hit && k.length > bestLen) { best = l; bestLen = k.length }
    }
  }
  return best
}

/**
 * The trim on clear: what to cut from the state file before new work. A clear is the cheap moment to prune,
 * since the model reads the whole file anyway. The checks are code (state-file.mjs); the cutting is the model's.
 */
function trimNote(file) {
  let info = null
  try { info = inspectStateFile(file, CONFIG.stateFile) } catch { info = null }
  if (!info) return ''
  const out = [
    'Then trim it before new work, and REWRITE it (never append): delete finished items from Now, delete Decisions ' +
      'the code no longer follows (check them), and move a rule that will outlive the current work to CLAUDE.md or ' +
      'the docs, then delete it here.',
  ]
  if (info.staleDone.length) {
    const shown = info.staleDone.slice(0, 8).map((r) => `  ${r.length > 140 ? r.slice(0, 140) + '...' : r}`)
    out.push(`Delete these Done items, older than ${info.doneDays} days:`, ...shown)
    if (info.staleDone.length > 8) out.push(`  ...and ${info.staleDone.length - 8} more.`)
  }
  if (info.overCap) {
    out.push(`The file is ${info.chars.toLocaleString('en-US')} characters, over the cap of ${info.maxChars.toLocaleString('en-US')}: cut it below the cap (delete, do not merge lines).`)
  }
  if (info.longBullets) {
    out.push(`${info.longBullets} bullet${info.longBullets === 1 ? ' is' : 's are'} over ${info.maxBulletChars} characters: one fact per bullet; cut each to its fact, or split it.`)
  }
  return out.join('\n') + '\n'
}

function main() {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { return 0 }
  const prompt = String(input?.prompt ?? '')
  if (!prompt.trim() || !existsSync(REGISTRY)) return 0
  const data = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  const lanes = Array.isArray(data?.lanes) ? data.lanes : []
  const dir = path.dirname(REGISTRY)

  const lead = prompt.trimStart()
  if (/^new:/i.test(lead)) return 0
  const laneCall = /^lane:\s*([^\n]+)/i.exec(lead)
  if (laneCall) {
    const lane = findLane(lanes, laneCall[1])
    if (lane) {
      const file = path.join(dir, `${lane.slug}.md`)
      const me = process.env.CLAUDE_CODE_HOST_SESSION_ID
      let claimed = null
      try { claimed = claimLane(REGISTRY, lane.slug, me) } catch { claimed = null }
      // Exit 0 with stdout: the text is added to the model's context.
      process.stdout.write(
        `This session is the "${lane.name}" lane. Before anything else, read its state file ${file}, ` +
          'then CLAUDE.md rules that apply. Keep that file current at the end of each piece of work.\n' +
          trimNote(file) +
          (claimed ? `lanes.json now names this session (${me}) as the ${lane.name} lane; it named ${claimed} before.\n` : '') +
          (me
            ? 'A lane session is never archived: call mcp__ccd_pr__get_status (self); if monitor.auto_archive_on_close ' +
              'is true, set it false with mcp__ccd_pr__set_monitor {"auto_archive_on_close": false}. Unbinding a PR does not change it.\n'
            : '') +
          // 2026-11-10: a hook cannot set the title on UserPromptSubmit (only SessionStart has
          // sessionTitle, and it fires before this message names the lane), so the model does it.
          `If this session's title is not "${lane.title || lane.name}", rename it to that with ` +
          'mcp__ccd_session_mgmt__set_session_title (session_id "self"); if it already is, do nothing.\n',
      )
    }
    return 0
  }

  if (!isFirstPrompt(input.transcript_path, prompt)) return 0
  if (isScheduledTask(prompt)) return 0

  const ranked = lanes
    .map((l) => ({ lane: l, hits: score(prompt, l) }))
    .filter((r) => r.hits.length > 0)
    .sort((a, b) => b.hits.length - a.hits.length)
  if (!ranked.length) return 0
  if (ranked[1] && ranked[1].hits.length === ranked[0].hits.length) return 0 // two lanes tie: not sure, let it through
  const { lane, hits } = ranked[0]
  if (!lane.sessionId) return 0 // the lane has no session yet: this one may become it

  const shown = prompt.length > 400 ? prompt.slice(0, 400) + '...' : prompt
  process.stderr.write(
    [
      `New session stopped: this looks like ${lane.name} work (matched: ${hits.slice(0, 4).join(', ')}).`,
      `That lane already has a session: "${lane.title || lane.name}". Continue there, so its context and state stay in one place.`,
      '',
      'Your message, to copy:',
      shown,
      '',
      'To start a new session anyway, send it again with "new:" at the start.',
      `If this IS the ${lane.name} session after a clear, start with "lane: ${lane.slug}".`,
      '',
    ].join('\n'),
  )
  return 2
}

let code = 0
try { code = main() } catch { code = 0 }
process.exit(code)
