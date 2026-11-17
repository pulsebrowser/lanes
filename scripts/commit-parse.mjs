/**
 * Reading a `git commit` out of a Bash command, for the commit gates (the second reader, the Verified line). Moved
 * here from second-reader-guard.mjs in 0.6.1, unchanged, so both gates read a commit the same way.
 */
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { GIT_PREFIX } from './brain-config.mjs'

export const COMMIT = new RegExp(GIT_PREFIX + String.raw`commit(?=\s|$)`, 'g')
const ADD = new RegExp(GIT_PREFIX + String.raw`add\s+([^;&|\n]+)`, 'g')
// Options of `git commit` that take a value, so the value is not read as a path.
const COMMIT_VALUE_OPTS = new Set(['-m', '--message', '-F', '--file', '-c', '-C', '--reuse-message', '--reedit-message',
  '--author', '--date', '--fixup', '--squash', '-t', '--template', '--cleanup', '--trailer'])
// A cluster of short flags ending in one that takes a value: `-am <msg>`, `-sm`, `-vm`, `-aF <file>`.
const VALUE_CLUSTER = /^-[a-zA-Z]*[mFCct]$/
export const unquote = (s) => s.replace(/^["']|["']$/g, '')
const words = (s) => (s.match(/"[^"]*"|'[^']*'|\S+/g) || []).map(unquote)
const gitIn = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean)

/** Where a git command at `index` runs: `git -C <dir>`, else the last `cd <dir>` before it, else the session's dir. */
export function dirFor(command, index, options, base) {
  const dashC = /-C(?:=|\s+)("[^"]+"|'[^']+'|\S+)/.exec(options || '')
  if (dashC) return path.resolve(base, unquote(dashC[1]))
  const cds = [...command.slice(0, index).matchAll(/(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)]
  return cds.length ? path.resolve(base, unquote(cds[cds.length - 1][1])) : base
}

/**
 * The text of ONE command, from `rest` up to its end: the first `;`, `&`, `|` or newline that is outside quotes and
 * outside `$( ... )`. A heredoc (`<<EOF ... EOF`) is part of its command. So `git commit -m "$(cat <<'EOF' ... EOF
 * )"` is one command, and `git commit -m x && echo "Second-Reader: y"` is not.
 */
export function ownCommand(rest) {
  let quote = null
  let depth = 0
  const heredocs = []
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') i++; continue }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '\\') { i++; continue }
    if (c === '$' && rest[i + 1] === '(') { depth++; i++; continue }
    if (c === ')' && depth > 0) { depth--; continue }
    const doc = /^<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/.exec(rest.slice(i))
    if (doc) { heredocs.push(doc[2]); i += doc[0].length - 1; continue }
    if (c === '\n' && heredocs.length) {
      // skip the heredoc bodies: up to the line that is exactly the terminator
      for (const end of heredocs.splice(0)) {
        const m = new RegExp(`\\n[ \\t]*${end}[ \\t]*(?=\\n|$)`).exec(rest.slice(i))
        if (!m) return rest
        i += m.index + m[0].length - 1
      }
      continue
    }
    if (depth === 0 && (c === ';' || c === '&' || c === '|' || c === '\n')) return rest.slice(0, i)
  }
  return rest
}

/**
 * The command with the text inside quotes and heredoc bodies blanked (same length, so positions stay), for a gate
 * that must not read "git commit" in a PR body or an echo as a commit. Quote characters and newlines are kept.
 */
export function maskQuoted(command) {
  const out = command.split('')
  let quote = null
  const heredocs = []
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (quote) {
      if (c === quote) { quote = null; continue }
      if (c === '\\' && quote === '"') { out[i] = ' '; if (i + 1 < command.length) out[++i] = ' '; continue }
      if (c !== '\n') out[i] = ' '
      continue
    }
    if (c === "'" || c === '"') { quote = c; continue }
    if (c === '\\') { i++; continue }
    const doc = /^<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/.exec(command.slice(i))
    if (doc) { heredocs.push(doc[2]); i += doc[0].length - 1; continue }
    if (c === '\n' && heredocs.length) {
      for (const end of heredocs.splice(0)) {
        const m = new RegExp(`\\n[ \\t]*${end}[ \\t]*(?=\\n|$)`).exec(command.slice(i))
        const stop = m ? i + m.index : command.length
        for (let j = i + 1; j < stop; j++) if (command[j] !== '\n') out[j] = ' '
        i = m ? i + m.index + m[0].length - 1 : command.length
      }
    }
  }
  return out.join('')
}

/** The `git commit` hits of a command that are commands, not words in quoted text; groups read from the command. */
export function commitHits(command) {
  const masked = maskQuoted(command)
  return [...masked.matchAll(COMMIT)].map((m) => {
    const real = new RegExp(COMMIT.source).exec(command.slice(m.index, m.index + m[0].length)) || m
    return Object.assign([...real], { index: m.index })
  })
}

/** One `git commit` of a command: its folder, its own text, and its options without the quoted text. */
export function commitAt(command, hit, base) {
  const dir = dirFor(command, hit.index, hit[1], base)
  const segment = ownCommand(command.slice(hit.index + hit[0].length))
  return { dir, segment, bare: segment.replace(/"[^"]*"|'[^']*'/g, ' ') }
}

/** The files this commit would take: staged, `-a`, `git commit <paths>`, and `git add <paths> &&` before it. */
export function commitFiles(command, hit, base) {
  const { dir, segment, bare } = commitAt(command, hit, base)
  const git = (...args) => lines(gitIn(dir, ...args))
  // Paths as git sees them from the repository root, for pathspecs that are folders, globs or relative to a `cd`.
  // One bad pathspec (a path outside the repo, a folder that does not exist) skips only that set, never the check:
  // the command itself would fail on it too, and the files staged so far are counted anyway.
  const changedUnder = (cwd, specs) => {
    if (!specs.length) return []
    try { return lines(gitIn(cwd, 'ls-files', '-m', '-o', '--exclude-standard', '--full-name', '--', ...specs)) } catch { return [] }
  }
  // --no-renames: a rename is its old path AND its new one, so moving a covered file (or a rule file) away is seen.
  const files = new Set(git('diff', '--cached', '--name-only', '--no-renames'))
  // `git commit -a` also takes every tracked change.
  if (/(?:^|\s)(-[a-zA-Z]*a[a-zA-Z]*|--all)(\s|$)/.test(bare)) git('diff', '--name-only', '--no-renames').forEach((f) => files.add(f))
  // `git commit <paths>` or `git commit -- <paths>` commits those paths.
  const commitWords = words(segment)
  const specs = []
  for (let i = 0; i < commitWords.length; i++) {
    const w = commitWords[i]
    if (w === '--') { specs.push(...commitWords.slice(i + 1)); break }
    if (COMMIT_VALUE_OPTS.has(w) || VALUE_CLUSTER.test(w)) { i++; continue }
    if (w.startsWith('-')) continue
    if (existsSync(path.resolve(dir, w))) specs.push(w) // a word of a message is not a path on disk
  }
  changedUnder(dir, specs).forEach((f) => files.add(f))
  // `git add <paths> && git commit` in one command: the paths are not staged yet when this hook runs.
  for (const add of command.slice(0, hit.index).matchAll(ADD)) {
    const addDir = dirFor(command, add.index, add[1], base)
    const tokens = words(add[2])
    // -A and -u stage the WHOLE repository from any folder (`:/` is git's name for the top), `.` only the folder.
    const all = tokens.some((t) => t === '-A' || t === '--all' || t === '-u' || t === '--update')
    const paths = tokens.filter((t) => !t.startsWith('-'))
    changedUnder(addDir, all ? [':/'] : paths).forEach((f) => files.add(f))
    // `git add -f` stages an ignored file, which ls-files --exclude-standard hides: count the paths as written.
    if (tokens.some((t) => t === '-f' || t === '--force')) {
      let prefix = ''
      try { prefix = lines(gitIn(addDir, 'rev-parse', '--show-prefix'))[0] || '' } catch { /* not a repo: nothing to add */ }
      paths.forEach((t) => files.add(path.posix.normalize(prefix + t)))
    }
  }
  return { dir, files }
}

/**
 * The message: this command's own text (-m, a heredoc, --trailer) and the file given to -F. Never text after the
 * command, and never a message that is reused (`--amend --no-edit`, `-C <commit>`): a line written for another diff
 * says nothing about this one ("a passing review on an out-of-date commit means nothing").
 */
export function commitMessage(command, hit, base) {
  const { dir, segment, bare } = commitAt(command, hit, base)
  let message = segment
  const dashF = /\s(?:-[a-zA-Z]*F\s*|--file(?:=|\s+))("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(' ' + bare.replace(/\s+/g, ' ') + ' ') ||
    /\s(?:-[a-zA-Z]*F\s*|--file(?:=|\s+))("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(' ' + segment)
  if (dashF) {
    const p = path.resolve(dir, unquote(dashF[1]))
    try { if (existsSync(p)) message += '\n' + readFileSync(p, 'utf8') } catch { /* unreadable: the command text only */ }
  }
  return message
}
