/**
 * The rules that judge a change, read so that the change cannot edit them (0.6.1).
 *
 * From Anthropic's "How the Claude Code team thinks about verification": if a change can modify the check that judges
 * it, the check is broken. Before 0.6.1 the guards read `.claude/brain.json` and the covered-files list from the working
 * tree, so a commit that dropped a file from the list (or deleted the list, or pointed `secondReader.coveredFiles`
 * elsewhere, or set a guard "off") passed the guard in that same commit, and a push guard read a `protectedBranch` the
 * agent had just changed.
 *
 * Now each rule is read from the working tree and from every BASE branch (baseRefs below), and the strictest wins:
 * - covered files: the union of all lists (a file dropped in the working tree is still covered);
 * - protected branches: every name;
 * - guard modes: the stricter mode (off < observe < enforce); the let-through count: the stricter count (0 = never).
 * So a change can tighten the rules at once; it loosens them only once it is merged, and the merge is the owner's.
 * The second-reader guard also treats the rule files themselves (brain.json and each covered list) as covered.
 *
 * Never throws: with no git, no base branch or a broken file, the working-tree rules are used, as before 0.6.1.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { settingsFrom, GUARDS, MODES } from './brain-config.mjs'

const uniq = (xs) => [...new Set(xs.filter((x) => typeof x === 'string' && x))]
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * The base refs. The working tree must not choose its own judge (a second read found `origin/<protectedBranch>` with
 * a protectedBranch from the working tree let a decoy branch be the base), so EVERY candidate that exists is read and
 * the strictest wins: origin's default branch (only a ref under refs/remotes/origin/), origin/main, origin/<each
 * protected branch named in the working tree or on a base>. The local branches count only in a repository with no
 * origin at all: a session can move a local branch (`git branch -f main work`) far more easily.
 */
function baseRefs(root, branches) {
  const tries = []
  try {
    const h = git(root, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).trim()
    if (h.startsWith('refs/remotes/origin/') && !h.includes('..')) tries.push(h)
  } catch { /* no origin HEAD */ }
  let hasOrigin = false
  try { hasOrigin = git(root, ['remote']).split('\n').map((r) => r.trim()).includes('origin') } catch { hasOrigin = false }
  for (const b of branches) tries.push(hasOrigin ? `refs/remotes/origin/${b}` : `refs/heads/${b}`)
  return uniq(tries).filter((ref) => {
    try { git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return true } catch { return false }
  })
}

const inRepo = (root, abs) => { const rel = path.relative(root, abs); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel) }

/** A file's text at `ref`, or null (no ref, no such file there, a path outside the repository). */
function atRef(root, ref, abs) {
  if (!ref || !inRepo(root, abs)) return null
  const rel = path.relative(root, abs)
  try { return git(root, ['show', `${ref}:./${rel.split(path.sep).join('/')}`]) } catch { return null }
}

const strictMode = (a, b) => (MODES.indexOf(b) > MODES.indexOf(a) ? b : a)
// 0 never lets a blocked command through, so it is the strictest; otherwise more blocks before the let-through.
const strictCount = (a, b) => (b === undefined ? a : a === 0 || b === 0 ? 0 : Math.max(a, b))

/** The project's folder inside the repository (`git rev-parse --show-prefix`, "" at the top or outside git). */
function prefixOf(root) {
  try { return git(root, ['rev-parse', '--show-prefix']).trim() } catch { return '' }
}
/** A project file's path as `git diff --name-only` prints it: from the top of the repository, posix. */
const repoPath = (root, prefix, abs) => path.posix.normalize(prefix + path.relative(root, abs).split(path.sep).join('/'))

export function loadRules(config) {
  const root = config.projectDir
  const local = inRepo(root, config.brainFile)
  // Every base, with the branches it names; a base with no brain.json has the DEFAULT settings, not none. A settings
  // file outside the repository (BRAIN_CONFIG) has no base copy: it counts alone.
  const bases = []
  let branches = uniq([config.protectedBranch, 'main'])
  for (let round = 0; round < 2; round++) {
    for (const ref of baseRefs(root, branches)) {
      if (bases.some((b) => b.ref === ref)) continue
      bases.push({ ref, settings: local ? settingsFrom(atRef(root, ref, config.brainFile) ?? '{}') : null })
    }
    branches = uniq([...branches, ...bases.map((b) => b.settings?.protectedBranch)])
  }
  const settings = bases.map((b) => b.settings).filter(Boolean)

  const coveredPaths = uniq([config.secondReader.coveredFiles, ...settings.map((b) => b.coveredFiles)]).map((p) => path.resolve(root, p))
  let covered = null
  for (const abs of coveredPaths) {
    let work = null
    try { work = existsSync(abs) ? readFileSync(abs, 'utf8') : null } catch { work = null }
    for (const text of [work, ...bases.map((b) => atRef(root, b.ref, abs))]) {
      if (text === null) continue
      let map
      try { map = JSON.parse(text) } catch { continue }
      if (!isObject(map)) continue
      covered = covered || {}
      for (const [area, entries] of Object.entries(map)) {
        if (Array.isArray(entries)) covered[area] = uniq([...(covered[area] || []), ...entries])
      }
    }
  }

  const modes = {}
  for (const g of GUARDS) modes[g] = settings.reduce((m, b) => strictMode(m, b.guards[g]), config.guards[g])
  const prefix = prefixOf(root)
  return {
    // The first base, for the report: origin's default branch when there is one.
    ref: bases[0]?.ref || null,
    refs: bases.map((b) => b.ref),
    fromBase: settings.length > 0,
    branches: uniq([config.protectedBranch, ...settings.map((b) => b.protectedBranch)]),
    covered,
    modes,
    letThroughAfter: settings.reduce((n, b) => strictCount(n, b.guards.letThroughAfter), config.guards.letThroughAfter),
    // Adding a kind to the Verified line loosens it: only the kinds every side accepts (none is always one).
    kinds: config.verified.kinds.filter((k) => settings.every((b) => b.kinds.includes(k))),
    // The files that hold the rules: a commit that changes one is judged like a covered file.
    ruleFiles: uniq([config.brainFile, ...coveredPaths].map((abs) => repoPath(root, prefix, abs))).filter((p) => p && !p.startsWith('..')),
  }
}

/** loadRules, never throwing: on an error of its own, the working-tree rules. */
export function safeRules(config) {
  try { return loadRules(config) } catch {
    let covered = null
    try { covered = JSON.parse(readFileSync(path.resolve(config.projectDir, config.secondReader.coveredFiles), 'utf8')) } catch { covered = null }
    return { ref: null, fromBase: false, branches: [config.protectedBranch], covered: isObject(covered) ? covered : null,
      modes: { ...config.guards }, letThroughAfter: config.guards.letThroughAfter, kinds: config.verified.kinds, ruleFiles: [], refs: [] }
  }
}
