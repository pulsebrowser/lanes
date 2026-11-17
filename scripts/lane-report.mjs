#!/usr/bin/env node
/**
 * How well routing works (0.6.0): per lane, over the last N days, from the lane inboxes (inbox-file.mjs).
 *
 *   node scripts/lane-report.mjs [--days 14] [--json]
 *
 * Per lane: requests that reached it, done, still open, moved out (the wrong lane), moved in, redone, the median
 * time to the lane's first answer and to done, and how many were marked done with no `answered` first (their answer
 * time is a guess). In all: how many of the owner's requests the first lane kept (the routing accuracy), and the mean
 * number of lanes a finished request went through (hops).
 *
 * Quality (0.6.1): per lane, the finished requests whose `done` named what showed the work right (`checked`), as
 * against "none: <why>" (lane-inbox.mjs done --evidence). For the project: the commits of the window by their
 * `Verified:` line (tests, app, tla, second-reader, none, or no line; verified-guard.mjs), and each guard's decisions
 * from the guard log (blocked, would-block in observe mode, let through after repeated blocks; guard-mode.mjs).
 *
 * Use it to decide merges or splits after a few weeks of data, not on a handful of requests: the counts are printed
 * next to every figure for that reason. Pure reads; it never writes. Items written before 0.6.0 have no routing
 * fields: they count as one hop, first lane right, with no answer time.
 * Env: LANE_REGISTRY (tests: path of lanes.json), CLAUDE_PROJECT_DIR (the project).
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { loadBrainConfig, isSafeSlug, GUARDS } from './brain-config.mjs'
import { inboxPath, readInbox, isOpen, oneLine, isNoneEvidence as isNone } from './inbox-file.mjs'
import { parseVerified } from './verified-line.mjs'
import { readGuardLog } from './guard-mode.mjs'
import { safeRules } from './rules.mjs'

const args = process.argv.slice(2)
const daysArg = Number(args[args.indexOf('--days') + 1])
const askedDays = args.includes('--days') && daysArg > 0 ? daysArg : 14
const asJson = args.includes('--json')
const HOUR = 60 * 60 * 1000

const median = (xs) => {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const span = (a, b) => {
  const t = Date.parse(b) - Date.parse(a)
  return Number.isFinite(t) && t >= 0 ? t : null
}

/**
 * The commits since `since` (no merges) on the base branch (merged work, the same whatever branch the report runs on),
 * else HEAD, counted by their Verified line. Null outside a git repository.
 */
function commitCounts(root, ref, since, kinds) {
  let text
  try {
    text = execFileSync('git', ['log', '--no-merges', `--since=${new Date(since).toISOString()}`, '--format=%x1e%B', ref || 'HEAD', '--'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 })
  } catch { return null }
  const out = { commits: 0, byKind: Object.fromEntries(kinds.map((k) => [k, 0])), noLine: 0, unusable: 0, checked: 0 }
  for (const body of text.split('\x1e').slice(1)) {
    out.commits++
    const r = parseVerified(body, kinds)
    if (r.kinds) {
      r.kinds.forEach((k) => { out.byKind[k]++ })
      if (!r.kinds.includes('none')) out.checked++
    } else if (/(?:^|\n)[ \t]*Verified:/.test(body)) out.unusable++
    else out.noLine++
  }
  return out
}

/** Each guard's decisions in the window, from the guard log. */
function guardCounts(file, since) {
  const out = Object.fromEntries(GUARDS.map((g) => [g, { blocked: 0, wouldBlock: 0, letThrough: 0 }]))
  for (const e of readGuardLog(file)) {
    if (!out[e.guard] || !(Date.parse(e.at) >= since)) continue
    if (e.decision === 'blocked') out[e.guard].blocked++
    else if (e.decision === 'would-block') out[e.guard].wouldBlock++
    else if (e.decision === 'let-through') out[e.guard].letThrough++
  }
  return out
}

const fmt = (ms) => (ms === null ? '-' : ms < HOUR ? `${Math.round(ms / 60000)} min` : ms < 48 * HOUR ? `${(ms / HOUR).toFixed(1)} h` : `${(ms / (24 * HOUR)).toFixed(1)} d`)

function main() {
  const config = loadBrainConfig()
  // Done and moved items are pruned after inbox.keepDays: a longer window would count only what is left.
  const keepDays = Number(config.inbox?.keepDays) > 0 ? Number(config.inbox.keepDays) : 60
  const days = Math.min(askedDays, keepDays)
  const registry = process.env.LANE_REGISTRY || path.join(config.lanesDir, 'lanes.json')
  if (!existsSync(registry)) return { text: `No lanes registry at ${registry}.` }
  const dir = path.dirname(registry)
  const lanes = (JSON.parse(readFileSync(registry, 'utf8')).lanes || []).filter((l) => isSafeSlug(l?.slug) && l.role !== 'conductor')
  const since = Date.now() - days * 24 * HOUR
  const inWindow = (i) => Date.parse(i.firstAt || i.at) >= since

  const rows = []
  const firstHop = { total: 0, kept: 0 }
  const finishedHops = []
  for (const l of lanes) {
    const files = [inboxPath(dir, l.slug), inboxPath(path.join(dir, 'retired'), l.slug)]
    const items = files.flatMap((f) => readInbox(f)).filter(inWindow)
    const hops = (i) => (Number(i.hops) > 0 ? Number(i.hops) : 1)
    const toAnswer = items.map((i) => (i.answeredAt && !i.answeredWithDone ? span(i.at, i.answeredAt) : null)).filter((x) => x !== null)
    const toDone = items.filter((i) => i.status === 'done').map((i) => span(i.firstAt || i.at, i.doneAt)).filter((x) => x !== null)
    for (const i of items) {
      if (hops(i) === 1) { firstHop.total++; if (i.status !== 'rerouted') firstHop.kept++ }
      if (i.status === 'done') finishedHops.push(hops(i))
    }
    rows.push({
      slug: l.slug,
      name: oneLine(l.name || l.slug, 40),
      retired: Boolean(l.retired),
      requests: items.length,
      done: items.filter((i) => i.status === 'done').length,
      open: items.filter(isOpen).length,
      movedOut: items.filter((i) => i.status === 'rerouted').length,
      movedIn: items.filter((i) => hops(i) > 1).length,
      redone: items.filter((i) => Number(i.redone) > 0).length,
      answerGuessed: items.filter((i) => i.answeredWithDone).length,
      medianToAnswerMs: median(toAnswer),
      answerCount: toAnswer.length,
      medianToDoneMs: median(toDone),
      doneCount: toDone.length,
      // Quality: of the finished requests, those whose evidence named a check, and those done with "none".
      checked: items.filter((i) => i.status === 'done' && i.evidence && !isNone(i.evidence)).length,
      noneEvidence: items.filter((i) => i.status === 'done' && i.evidence && isNone(i.evidence)).length,
    })
  }
  const totals = {
    days,
    requests: firstHop.total,
    firstLaneRight: firstHop.kept,
    accuracy: firstHop.total ? firstHop.kept / firstHop.total : null,
    meanHopsFinished: finishedHops.length ? finishedHops.reduce((a, b) => a + b, 0) / finishedHops.length : null,
    finished: finishedHops.length,
  }
  // Commits and the guard log are not pruned with the inboxes: they take the days asked for.
  const sinceAsked = Date.now() - askedDays * 24 * HOUR
  const rules = safeRules(config)
  const commits = commitCounts(config.projectDir, rules.ref, sinceAsked, config.verified.kinds)
  const guards = guardCounts(config.guards.log, sinceAsked)
  if (asJson) return { text: JSON.stringify({ totals, lanes: rows, commits, guards }, null, 2) }

  const head = ['lane', 'requests', 'done', 'open', 'moved out', 'moved in', 'redone', 'to answer (n)', 'to done (n)', 'no answer mark', 'checked']
  const body = rows.map((r) => [
    `${r.name}${r.retired ? ' (retired)' : ''}`, r.requests, r.done, r.open, r.movedOut, r.movedIn, r.redone,
    `${fmt(r.medianToAnswerMs)} (${r.answerCount})`, `${fmt(r.medianToDoneMs)} (${r.doneCount})`, r.answerGuessed,
    `${r.checked}/${r.done}`,
  ].map(String))
  const width = head.map((h, c) => Math.max(h.length, ...body.map((b) => b[c].length)))
  const line = (cells) => cells.map((v, c) => (c === 0 ? v.padEnd(width[c]) : v.padStart(width[c]))).join('  ')
  const out = [
    `Lane report, last ${days} days (${registry})${days < askedDays ? `: inboxes keep only ${keepDays} days (inbox.keepDays)` : ''}`,
    '',
    line(head),
    ...body.map(line),
    '',
    totals.requests
      ? `Requests: ${totals.requests}. The first lane kept ${totals.firstLaneRight} (${Math.round(totals.accuracy * 100)}%); ` +
        `finished requests went through ${totals.meanHopsFinished === null ? '-' : totals.meanHopsFinished.toFixed(2)} lanes on average (${totals.finished} finished).`
      : 'No requests in this window.',
    'Times are medians: "to answer" from arrival in the lane to its first answer, "to done" from the first lane to done.',
    '"checked": finished requests whose done named what showed it works (a test, a screenshot, a log); the rest said ' +
      '"none" or were done before evidence was asked for (0.6.1).',
    '',
    commits === null
      ? 'Commits: not a git repository.'
      : `Commits on ${rules.ref ? rules.ref.replace(/^refs\/(remotes|heads)\//, '') : 'HEAD'}, last ${askedDays} days: ${commits.commits}, ${commits.checked} with a check. Verified: ` +
        Object.entries(commits.byKind).map(([k, n]) => `${k} ${n}`).join(', ') +
        `, no line ${commits.noLine}${commits.unusable ? `, unreadable line ${commits.unusable}` : ''}.`,
    'Guards (blocked / would-block / let through): ' + Object.entries(guards).map(([g, c]) => `${g} ${c.blocked}/${c.wouldBlock}/${c.letThrough}`).join(', ') + '.',
    'A merge or split needs weeks of data: read every figure with its count.',
  ]
  return { text: out.join('\n') }
}

let out = ''
try { out = main().text } catch (e) { out = `Could not build the report: ${e?.message || e}`; process.exitCode = 1 }
process.stdout.write(out + '\n')
