#!/usr/bin/env node
/**
 * Lane PR guard. A Claude Code PreToolUse hook on Bash.
 *
 * Lane sessions are never archived: they clear in place. But the Claude desktop app setting "archive sessions when
 * their pull request closes" archives ANY session that owns a pull request once it merges, and it knows nothing
 * about lanes. A lane session that opens a PR is archived at the merge (it happened to a real lane on 2026-11-11).
 *
 * This hook stops `gh pr create` (and `gh pr new`) when the session running it is a lane session, that is when
 * CLAUDE_CODE_HOST_SESSION_ID (set by the desktop app, `local_...`) is the sessionId of a lane in lanes.json.
 * Other sessions are not touched; outside the desktop app the variable is unset and the hook does nothing.
 * Escape for one PR: put the comment `# lane-pr: unbind` in the command, then unbind the PR from the session at once.
 * It fails OPEN: on any error of its own the command goes through.
 *
 * Input: hook JSON on stdin ({ tool_name, tool_input: { command } }). Exit 2 blocks; stderr goes to the agent.
 * Env: CLAUDE_CODE_HOST_SESSION_ID (this session), LANE_REGISTRY (tests: path of lanes.json).
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadBrainConfig } from './brain-config.mjs'

// the lane registry: `lanesDir` of .claude/brain.json (brain-config.mjs)
const REGISTRY = process.env.LANE_REGISTRY || path.join(loadBrainConfig().lanesDir, 'lanes.json')
const PR_CREATE = /(?:^|[\s;&|(])gh\s+pr\s+(?:create|new)\b/
const OVERRIDE = /#\s*lane-pr:\s*unbind/i

function main() {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { return 0 }
  if (input?.tool_name !== 'Bash') return 0
  const command = String(input?.tool_input?.command ?? '')
  if (!PR_CREATE.test(command) || OVERRIDE.test(command)) return 0

  const me = process.env.CLAUDE_CODE_HOST_SESSION_ID
  if (!me || !existsSync(REGISTRY)) return 0
  const { lanes = [] } = JSON.parse(readFileSync(REGISTRY, 'utf8'))
  const lane = lanes.find((l) => l?.sessionId && l.sessionId === me)
  if (!lane) return 0

  process.stderr.write(
    [
      `PR stopped: this is the "${lane.name}" lane session, and lane sessions must not own a pull request.`,
      'The app archives a session when its PR closes (setting on), so this lane would be archived at the merge.',
      '',
      'Do one of these:',
      '  1. Start a task session (start_session, brief starting with "new:") to open the PR. It is archived at the merge, as it should be.',
      '  2. Open it here and give the PR away at once: add the comment `# lane-pr: unbind` to the command,',
      '     then unbind the PR from this session straight after (mcp__ccd_pr__unbind_pr in the desktop app).',
      '',
    ].join('\n'),
  )
  return 2
}

let code = 0
try { code = main() } catch { code = 0 }
process.exit(code)
