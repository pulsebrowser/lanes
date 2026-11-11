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
 *   secondReader      { coveredFiles, verifyCommand, skill }: the JSON map of area -> covered paths (relative to
 *                     the project), the command that checks an area, and the skill a fresh reader follows.
 *
 * Env: BRAIN_CONFIG (path of the file, tests), CLAUDE_PROJECT_DIR (the project, set by Claude Code for hooks).
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
  secondReader: {
    coveredFiles: '.claude/covered-files.json',
    verifyCommand: null, // optional: a check that must pass before the read, e.g. a model checker
    skill: 'the lanes:second-reader skill',
  },
}

const home = (p) => (p === '~' ? os.homedir() : p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p)

/** The project folder: CLAUDE_PROJECT_DIR (Claude Code sets it for hooks), else the current folder. */
export function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd()
}

/** The merged config, with folder paths made absolute. Never throws. */
export function loadBrainConfig() {
  const root = projectDir()
  let file = {}
  try {
    const p = process.env.BRAIN_CONFIG || path.join(root, '.claude', 'brain.json')
    if (existsSync(p)) file = JSON.parse(readFileSync(p, 'utf8')) || {}
  } catch {
    file = {}
  }
  const cfg = {
    ...DEFAULTS,
    ...file,
    stateFile: { ...DEFAULTS.stateFile, ...(file.stateFile || {}) },
    secondReader: { ...DEFAULTS.secondReader, ...(file.secondReader || {}) },
  }
  cfg.lanesDir = path.resolve(home(cfg.lanesDir || path.join('~', '.claude', 'lanes', path.basename(root))))
  cfg.scheduledTasksDir = path.resolve(home(cfg.scheduledTasksDir))
  cfg.projectDir = root
  return cfg
}

/** A string as a literal inside a RegExp. */
export const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
