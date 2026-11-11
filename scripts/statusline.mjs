#!/usr/bin/env node
/**
 * Lane status line. A Claude Code `statusLine` command: prints the lane this session is, so you always know which
 * session you are typing into. Prints nothing in a session that is not a lane.
 *
 * How it finds the lane, first match wins:
 *   1. the session id is a lane's `sessionId` in lanes.json. Both ids count: the desktop app's
 *      CLAUDE_CODE_HOST_SESSION_ID (`local_...`) and the `session_id` Claude Code passes on stdin.
 *   2. the session's first typed message is `lane: <slug>` or `new: lane <slug>` (how a lane starts and how it
 *      resumes after a clear), and that slug is in lanes.json. This also works in the terminal, where /clear
 *      gives the session a new id.
 * It reads only the start of the transcript, and it fails quiet: on any error it prints nothing.
 *
 * Input: status line JSON on stdin ({ session_id, transcript_path, workspace: { project_dir }, cwd }).
 * When the lane's state file is over its cap (stateFile.maxLines, state-file.mjs), it adds ", state file N lines".
 * Env: LANE_REGISTRY (tests: path of lanes.json), LANES_STATUSLINE_FORMAT (default "lane: {name}"; also {slug}).
 */
import { readFileSync, existsSync, openSync, readSync, closeSync } from 'node:fs'
import path from 'node:path'

const HEAD_BYTES = 256 * 1024
const START = /^\s*(?:lane:\s*|new:\s*lane\s+)([a-z0-9][\w-]*)/i

/** The first typed user message of a transcript (JSONL), from its first HEAD_BYTES only. */
function firstPrompt(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return ''
  const fd = openSync(transcriptPath, 'r')
  const buf = Buffer.alloc(HEAD_BYTES)
  const n = readSync(fd, buf, 0, HEAD_BYTES, 0)
  closeSync(fd)
  for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
    if (!line.includes('"type":"user"')) continue
    let e
    try { e = JSON.parse(line) } catch { continue }
    if (e.type !== 'user' || e.isMeta || e.isCompactSummary) continue
    const c = e.message?.content
    if (Array.isArray(c) && c.some((p) => p?.type === 'tool_result')) continue
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p?.type === 'text').map((p) => p.text).join(' ') : ''
    if (!text || text.trimStart().startsWith('<')) continue // command and system wrappers, not typed prompts
    return text
  }
  return ''
}

async function main() {
  let input = {}
  try { input = JSON.parse(readFileSync(0, 'utf8') || '{}') } catch { input = {} }

  // the status line runs outside the hook env: take the project from stdin before reading .claude/brain.json
  const project = input?.workspace?.project_dir || input?.cwd
  if (project && !process.env.CLAUDE_PROJECT_DIR) process.env.CLAUDE_PROJECT_DIR = project
  const { loadBrainConfig } = await import('./brain-config.mjs')
  const { inspectStateFile } = await import('./state-file.mjs')
  const config = loadBrainConfig()
  const registry = process.env.LANE_REGISTRY || path.join(config.lanesDir, 'lanes.json')
  if (!existsSync(registry)) return ''
  const { lanes = [] } = JSON.parse(readFileSync(registry, 'utf8'))

  const ids = [process.env.CLAUDE_CODE_HOST_SESSION_ID, input?.session_id].filter(Boolean)
  let lane = lanes.find((l) => l?.sessionId && ids.includes(l.sessionId))
  if (!lane) {
    const slug = START.exec(firstPrompt(input?.transcript_path))?.[1]?.toLowerCase()
    if (slug) lane = lanes.find((l) => String(l?.slug).toLowerCase() === slug)
  }
  if (!lane) return ''

  const format = process.env.LANES_STATUSLINE_FORMAT || 'lane: {name}'
  const line = format.replaceAll('{name}', lane.name || lane.slug).replaceAll('{slug}', lane.slug)
  let info = null
  try { info = inspectStateFile(path.join(path.dirname(registry), `${lane.slug}.md`), config.stateFile) } catch { info = null }
  return info?.overCap ? `${line}, state file ${info.lines} lines` : line
}

main()
  .then((line) => { if (line) process.stdout.write(line + '\n') })
  .catch(() => {})
