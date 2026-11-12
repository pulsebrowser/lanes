#!/usr/bin/env node
/**
 * Lane PR guard. A Claude Code PreToolUse hook on Bash.
 *
 * Lane sessions are never archived: they clear in place. But the Claude desktop app setting "archive sessions when
 * their pull request closes" archives a session once a PR it touched merges, and it knows nothing about lanes
 * (it happened to one real lane three times, 2026-11-10 to 11-11).
 *
 * The real fix is per session (0.3.2, tested 2026-11-12): the app copies that setting into each session as the switch
 * `auto_archive_on_close`, and a session can turn its OWN switch off (mcp__ccd_pr__set_monitor). Unbinding the PR
 * does NOT change the switch. A lane whose switch is off can own PRs safely; this guard is the backup for a lane
 * that has not turned it off yet.
 *
 * This hook stops `gh pr create` (and `gh pr new`) when the session running it is a lane session, that is when
 * CLAUDE_CODE_HOST_SESSION_ID (set by the desktop app, `local_...`) is the sessionId of a lane in lanes.json.
 * Other sessions are not touched; outside the desktop app the variable is unset and the hook does nothing.
 * Escape: put the comment `# lane-pr: ok` in the command once this session's switch is off
 * (`# lane-pr: unbind`, from 0.1.0 to 0.3.1, still works).
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
const OVERRIDE = /#\s*lane-pr:\s*(?:ok|unbind)\b/i

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
      'The desktop app archives a session when a PR it touched closes, unless the session turned its own',
      'auto_archive_on_close switch off. Unbinding the PR does NOT change that switch.',
      '',
      'Do one of these:',
      '  1. Turn this session\'s switch off once: mcp__ccd_pr__set_monitor with {"auto_archive_on_close": false},',
      '     check it with mcp__ccd_pr__get_status, then run the command again with the comment `# lane-pr: ok`.',
      '  2. Or start a task session (start_session, brief starting with "new:") to open the PR. It is archived at the merge, as it should be.',
      '',
    ].join('\n'),
  )
  return 2
}

let code = 0
try { code = main() } catch { code = 0 }
process.exit(code)
