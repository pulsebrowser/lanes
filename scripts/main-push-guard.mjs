#!/usr/bin/env node
/**
 * Protected-branch push guard. A Claude Code PreToolUse hook on Bash.
 *
 * Every change reaches the protected branch through a pull request, so CI runs before the branch sees it. GitHub
 * branch protection enforces this on the server, but a private repository on a free plan cannot have it. This hook
 * is the free half: it stops an AGENT's `git push` that writes to the protected branch. A push typed by a person in
 * a terminal does not go through it.
 *
 * Stopped: `git push <remote> <branch>`, `... HEAD:<branch>`, `... <ref>:<branch>`, `... refs/heads/<branch>`, and a
 * bare `git push` (or `git push <remote>`) while the current branch is the protected one.
 * The owner's word for one push: put the comment `# main-push: <owner>'s word` in the same command.
 * The branch and the owner come from .claude/brain.json (`protectedBranch`, `owner`).
 * It fails OPEN: on any error of its own the push goes through.
 *
 * Input: hook JSON on stdin ({ tool_name, tool_input: { command }, cwd }). Exit 2 blocks; stderr goes to the agent.
 */
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { loadBrainConfig, escapeRegExp } from './brain-config.mjs'

const { owner: OWNER, protectedBranch: BRANCH } = loadBrainConfig()
const PUSH = /(?:^|[\s;&|(])git((?:\s+-C\s+(?:"[^"]+"|'[^']+'|\S+)|\s+-c\s+\S+)*)\s+push\b([^;&|\n]*)/g
const OVERRIDE = new RegExp(`#\\s*main-push:\\s*${escapeRegExp(OWNER)}'s word`, 'i')
const unquote = (s) => s.replace(/^["']|["']$/g, '')

function currentBranch(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}

/** True when this push's arguments write to the protected branch. */
function pushesMain(args, branch) {
  const words = args.trim().split(/\s+/).filter(Boolean).map(unquote)
  const positional = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (w === '--repo' || w === '-o' || w === '--push-option' || w === '--receive-pack' || w === '--exec') { i++; continue }
    if (w.startsWith('-')) continue
    positional.push(w)
  }
  const refspecs = positional.slice(1) // the first positional word is the remote
  if (refspecs.length === 0) return branch === BRANCH && !words.includes('--tags') // `git push --tags` sends tags only
  return refspecs.some((r) => {
    const dst = (r.includes(':') ? r.split(':').pop() : r).replace(/^\+/, '')
    return dst === BRANCH || dst === `refs/heads/${BRANCH}` || (dst === 'HEAD' && branch === BRANCH)
  })
}

function main() {
  let input
  try { input = JSON.parse(readFileSync(0, 'utf8')) } catch { return 0 }
  if (input?.tool_name !== 'Bash') return 0
  const command = String(input?.tool_input?.command ?? '')
  if (OVERRIDE.test(command)) return 0

  for (const hit of command.matchAll(PUSH)) {
    let dir = input.cwd || process.cwd()
    const dashC = /-C\s+("[^"]+"|'[^']+'|\S+)/.exec(hit[1] || '')
    const cds = [...command.slice(0, hit.index).matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)]
    if (dashC) dir = path.resolve(dir, unquote(dashC[1]))
    else if (cds.length) dir = path.resolve(dir, unquote(cds[cds.length - 1][1]))
    if (!pushesMain(hit[2] || '', currentBranch(dir))) continue

    process.stderr.write(
      [
        `Push stopped: changes reach ${BRANCH} through a pull request.`,
        'Push your own branch and open a PR instead, for example:',
        '  git push -u origin <your-branch>',
        `  gh pr create --base ${BRANCH} --fill`,
        `CI runs on the PR. The merge needs ${OWNER}'s word (or a click on Merge on GitHub).`,
        '',
        `Only ${OWNER} can allow one direct push to ${BRANCH}. With that word for this push, add this comment to the command:`,
        `  # main-push: ${OWNER}'s word`,
        '',
      ].join('\n'),
    )
    return 2
  }
  return 0
}

let code = 0
try { code = main() } catch { code = 0 }
process.exit(code)
