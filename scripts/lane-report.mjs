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
 * Use it to decide merges or splits after a few weeks of data, not on a handful of requests: the counts are printed
 * next to every figure for that reason. Pure reads; it never writes. Items written before 0.6.0 have no routing
 * fields: they count as one hop, first lane right, with no answer time.
 * Env: LANE_REGISTRY (tests: path of lanes.json), CLAUDE_PROJECT_DIR (the project).
 */
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { loadBrainConfig, isSafeSlug } from './brain-config.mjs'
import { inboxPath, readInbox, isOpen, oneLine } from './inbox-file.mjs'

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
  if (asJson) return { text: JSON.stringify({ totals, lanes: rows }, null, 2) }

  const head = ['lane', 'requests', 'done', 'open', 'moved out', 'moved in', 'redone', 'to answer (n)', 'to done (n)', 'no answer mark']
  const body = rows.map((r) => [
    `${r.name}${r.retired ? ' (retired)' : ''}`, r.requests, r.done, r.open, r.movedOut, r.movedIn, r.redone,
    `${fmt(r.medianToAnswerMs)} (${r.answerCount})`, `${fmt(r.medianToDoneMs)} (${r.doneCount})`, r.answerGuessed,
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
    'A merge or split needs weeks of data: read every figure with its count.',
  ]
  return { text: out.join('\n') }
}

let out = ''
try { out = main().text } catch (e) { out = `Could not build the report: ${e?.message || e}`; process.exitCode = 1 }
process.stdout.write(out + '\n')
