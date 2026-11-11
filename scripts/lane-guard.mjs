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
 *
 * Exempt: scheduled task runs (their prompt is the task's SKILL.md body). It matches keywords in code, no model
 * call. It fails OPEN: any error of its own lets the message through.
 *
 * Input: hook JSON on stdin ({ prompt, transcript_path, session_id }). Exit 2 blocks; stderr is shown to the user.
 * Env (tests): LANE_REGISTRY (path of lanes.json), LANE_TASKS_DIR (scheduled tasks folder).
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { loadBrainConfig, escapeRegExp as escape } from './brain-config.mjs'
import { inspectStateFile } from './state-file.mjs'

const CONFIG = loadBrainConfig()
const REGISTRY = process.env.LANE_REGISTRY || path.join(CONFIG.lanesDir, 'lanes.json')
const TASKS_DIR = process.env.LANE_TASKS_DIR || CONFIG.scheduledTasksDir

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim()

/** True when the transcript holds no earlier typed prompt (a new or just-cleared session). */
function isFirstPrompt(transcriptPath, prompt) {
  if (!transcriptPath || !existsSync(transcriptPath)) return true
  const current = norm(prompt)
  for (const line of readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.includes('"type":"user"')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'user' || e.isMeta || e.isCompactSummary) continue
    const c = e.message?.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : ''
    if (!text || (Array.isArray(c) && c.some((p) => p?.type === 'tool_result'))) continue
    if (text.trimStart().startsWith('<')) continue // command and system wrappers, not typed prompts
    if (norm(text) !== current) return false
  }
  return true
}

/** True when the prompt is a scheduled task's own instructions. */
function isScheduledTask(prompt) {
  if (!existsSync(TASKS_DIR)) return false
  const p = norm(prompt)
  for (const dir of readdirSync(TASKS_DIR)) {
    const f = path.join(TASKS_DIR, dir, 'SKILL.md')
    if (!existsSync(f)) continue
    const body = norm(readFileSync(f, 'utf8').replace(/^---[\s\S]*?\n---\n/, ''))
    const head = body.slice(0, 120)
    if (head && (p.includes(head) || body.includes(p.slice(0, 120)))) return true
  }
  return false
}

function score(prompt, lane) {
  const p = norm(prompt)
  return (lane.keywords || []).filter((k) => new RegExp(`(^|[^a-z0-9])${escape(norm(k))}($|[^a-z0-9])`).test(p))
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
  const { lanes = [] } = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  const dir = path.dirname(REGISTRY)

  const lead = prompt.trimStart()
  if (/^new:/i.test(lead)) return 0
  const laneCall = /^lane:\s*([^\n]+)/i.exec(lead)
  if (laneCall) {
    const want = norm(laneCall[1]).split(' ').slice(0, 4).join(' ')
    const lane = lanes.find((l) => want.startsWith(norm(l.slug)) || want.startsWith(norm(l.name)))
    if (lane) {
      const file = path.join(dir, `${lane.slug}.md`)
      // Exit 0 with stdout: the text is added to the model's context.
      process.stdout.write(
        `This session is the "${lane.name}" lane. Before anything else, read its state file ${file}, ` +
          'then CLAUDE.md rules that apply. Keep that file current at the end of each piece of work.\n' +
          trimNote(file) +
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
