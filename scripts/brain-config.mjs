/**
 * The one place the hooks read their project settings from: `.claude/brain.json` in the project.
 * Every key is optional; a missing key takes the default below, and a missing or broken file gives all the defaults.
 *
 *   owner             the person whose word allows an exception. Shown in messages and used in the
 *                     override comment: `# main-push: <owner>'s word`.
 *   protectedBranch   the branch agents never push to directly ("main").
 *   lanesDir          the folder that holds lanes.json and one <slug>.md state file per lane. Keep it outside git.
 *                     `~` is the home folder.
 *   scheduledTasksDir the folder of scheduled task SKILL.md files (their runs pass the lane guard).
 *   stateFile         { maxChars, maxBulletChars, doneDays }: a lane state file over maxChars (12000, about 3000
 *                     tokens) is flagged, bullets over maxBulletChars (300) are counted, and "Done" items older than
 *                     doneDays (7) are named for deletion, on each `lane: <slug>` (state-file.mjs).
 *   inbox             { keepDays }: done and moved inbox requests are kept this many days (60) for lane-report.mjs.
 *   secondReader      { coveredFiles, verifyCommand, skill }: the JSON map of area -> covered paths (relative to
 *                     the project), the command that checks an area, and the skill a fresh reader follows.
 *   guards            { lane, lanePr, mainPush, secondReader, verified, letThroughAfter, log } (0.6.1): each guard's
 *                     mode, "off", "observe" (log what would have been blocked, block nothing) or "enforce". The four
 *                     guards before 0.6.1 default to "enforce", the Verified line to "observe". A commit gate
 *                     (secondReader, verified) that blocked one session `letThroughAfter` times (2) lets the next try
 *                     through and logs it; 0 never lets through. `log` is the JSONL file of every decision (default
 *                     <lanesDir>/guard-log.jsonl). The rules that judge a change are read from the base branch too
 *                     (rules.mjs): a change in the working tree can make them stricter at once, never looser.
 *   verified          { kinds }: the words a `Verified:` commit line may use (tests, app, tla, second-reader, none).
 *
 * Env: BRAIN_CONFIG (path of the file, tests), GUARD_LOG (path of the guard log, tests), CLAUDE_PROJECT_DIR (the project, set by Claude Code for hooks).
 */
import { readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULTS = {
  owner: 'the owner',
  protectedBranch: 'main',
  lanesDir: null, // default: ~/.claude/lanes/<project folder name>
  scheduledTasksDir: '~/.claude/scheduled-tasks',
  stateFile: { maxChars: 12000, maxBulletChars: 300, doneDays: 7 },
  inbox: { keepDays: 60 },
  guards: { lane: 'enforce', lanePr: 'enforce', mainPush: 'enforce', secondReader: 'enforce', verified: 'observe', letThroughAfter: 2, log: null },
  verified: { kinds: ['tests', 'app', 'tla', 'second-reader', 'none'] },
  secondReader: {
    coveredFiles: '.claude/covered-files.json',
    verifyCommand: null, // optional: a check that must pass before the read, e.g. a model checker
    skill: 'the lanes:second-reader skill',
  },
}

/** `~` or `~/...` (or `~\\...` on Windows) made absolute. */
const home = (p) => (p === '~' ? os.homedir() : /^~[\\/]/.test(p) ? path.join(os.homedir(), p.slice(2)) : p)
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v, fallback) => (typeof v === 'string' && v.trim() ? v : fallback)

/** The settings file: BRAIN_CONFIG (tests), else <project>/.claude/brain.json. */
export const brainFile = (root = projectDir()) => path.resolve(root, process.env.BRAIN_CONFIG || path.join('.claude', 'brain.json'))

/** The project folder: CLAUDE_PROJECT_DIR (Claude Code sets it for hooks), else the current folder. */
export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd()
}

/**
 * The merged config, with folder paths made absolute. Never throws: a missing or broken file, or a key of the
 * wrong type (`"lanesDir": null`, `"owner": 3`), gives that key's default. The hooks call it at load time, outside
 * their own try, so a throw here would turn every hook into an error on every call.
 */
export function loadBrainConfig() {
  const root = projectDir()
  let file = {}
  try {
    const p = brainFile(root)
    if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    file = {}
  }
  if (!isObject(file)) file = {}
  const stateFile = isObject(file.stateFile) ? file.stateFile : {}
  const inbox = isObject(file.inbox) ? file.inbox : {}
  const secondReader = isObject(file.secondReader) ? file.secondReader : {}
  const guards = isObject(file.guards) ? file.guards : {}
  const verified = isObject(file.verified) ? file.verified : {}
  const cfg = {
    owner: str(file.owner, DEFAULTS.owner),
    protectedBranch: str(file.protectedBranch, DEFAULTS.protectedBranch),
    stateFile: { ...DEFAULTS.stateFile, ...stateFile },
    inbox: { ...DEFAULTS.inbox, ...inbox },
    guards: guardSettings(guards),
    verified: { kinds: kindsFrom(verified) },
    secondReader: {
      coveredFiles: str(secondReader.coveredFiles, DEFAULTS.secondReader.coveredFiles),
      verifyCommand: str(secondReader.verifyCommand, DEFAULTS.secondReader.verifyCommand),
      skill: str(secondReader.skill, DEFAULTS.secondReader.skill),
    },
  }
  cfg.lanesDir = path.resolve(home(str(file.lanesDir, path.join('~', '.claude', 'lanes', path.basename(root)))))
  cfg.guards.log = path.resolve(home(process.env.GUARD_LOG || str(guards.log, path.join(cfg.lanesDir, 'guard-log.jsonl'))))
  cfg.scheduledTasksDir = path.resolve(home(str(file.scheduledTasksDir, DEFAULTS.scheduledTasksDir)))
  cfg.projectDir = root
  cfg.brainFile = brainFile(root)
  return cfg
}

export const GUARDS = ['lane', 'lanePr', 'mainPush', 'secondReader', 'verified']
export const MODES = ['off', 'observe', 'enforce'] // in order: a later mode is stricter

/** Each guard's mode (a bad value takes the default) and the let-through count (a whole number, 0 = never). */
function guardSettings(g) {
  const out = {}
  for (const name of GUARDS) out[name] = MODES.includes(g[name]) ? g[name] : DEFAULTS.guards[name]
  const n = g.letThroughAfter
  out.letThroughAfter = Number.isInteger(n) && n >= 0 ? n : DEFAULTS.guards.letThroughAfter
  return out
}

/** A config file's text (another version of brain.json, rules.mjs) as the same settings, defaults for what is missing. */
export function settingsFrom(text) {
  let file = {}
  try { file = JSON.parse(text) } catch { file = {} }
  if (!isObject(file)) file = {}
  const secondReader = isObject(file.secondReader) ? file.secondReader : {}
  return {
    protectedBranch: str(file.protectedBranch, DEFAULTS.protectedBranch),
    coveredFiles: str(secondReader.coveredFiles, DEFAULTS.secondReader.coveredFiles),
    guards: guardSettings(isObject(file.guards) ? file.guards : {}),
    kinds: kindsFrom(isObject(file.verified) ? file.verified : {}),
  }
}

/** The kinds of the Verified line: a list of short lowercase words, with none always one of them. */
function kindsFrom(verified) {
  return Array.isArray(verified.kinds) && verified.kinds.length && verified.kinds.every((k) => typeof k === 'string' && /^[a-z][\w-]*$/.test(k))
    ? [...new Set([...verified.kinds, 'none'])]
    : DEFAULTS.verified.kinds
}

/** A lane slug that is safe to use in a file name: letters, digits, `_`, `-` and `.`, never `..`, no path parts. */
export const isSafeSlug = (s) => typeof s === 'string' && /^[a-z0-9][\w.-]*$/i.test(s) && !s.includes('..')

/**
 * The start of a `git` command, for the Bash guards: `git`, `/usr/bin/git`, with any global options
 * (`-C <dir>`, `-c k=v`, `--git-dir=.git`, `--no-pager`) before the subcommand. Group 1 holds the options.
 * The two option branches never match the same text (the second refuses the names the first takes), so a long run of
 * options has ONE way to match: no exponential backtracking on a hostile command (0.3.3 second review).
 */
const TAKES_VALUE = String.raw`(?:-C|-c|--git-dir|--work-tree|--namespace)`
export const GIT_PREFIX = String.raw`(?:^|[\s;&|(])(?:[^\s;&|()]*\/)?git((?:\s+${TAKES_VALUE}(?:=|\s+)(?:"[^"]+"|'[^']+'|\S+)|\s+(?!${TAKES_VALUE}(?:=|\s|$))--?[a-zA-Z][\w-]*(?:=\S+)?)*)\s+`

/** A string as a literal inside a RegExp. */
export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
