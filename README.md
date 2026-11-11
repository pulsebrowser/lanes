# Lanes

Long Claude Code sessions forget what they knew. Each compaction keeps a summary of a summary.
Fresh sessions multiply: after a week, ten of them each hold part of the story, and none of them holds all of it.

Lanes is the setup one founder uses to run a whole company's code with Claude Code, packaged as a plugin:

- **One lane per kind of work.** Each lane is ONE session that lives for months, plus ONE state file outside git that the session rereads after every clear. The conversation can go; the state stays.
- **A lane guard.** A hook reads the first message of every new session. If that work already has a lane, it stops the message and names the session to continue in. `new:` overrides it. `lane: <slug>` resumes a lane after a clear.
- **A second reader.** A hook stops a commit of your riskiest files (billing, auth, consent: you list them) until a fresh agent that did not write the change has read the staged diff.
- **A push guard.** A hook stops an agent's push to your protected branch, so every change goes through a pull request and CI. Free, for repos where GitHub branch protection is not available.
- **A dreaming pass.** A monthly skill that checks your notes against the code, merges duplicates and lists rules that no longer carry load.

The full story, with what worked and what did not: [One person, six lanes](https://pulseos.finance/blog/one-person-six-lanes).

## Install

In Claude Code:

```
/plugin marketplace add pulsebrowser/lanes
/plugin install lanes@lanes
```

Then ask Claude to set up lanes in your project (the `lanes:lanes` skill walks through it), or copy the files in [`templates/`](templates/) yourself.

To work on the plugin itself, clone it and run `claude --plugin-dir ./lanes`.

## Configure

The hooks read one file in your project, `.claude/brain.json`. Every key is optional.

```json
{
  "owner": "Ada",
  "protectedBranch": "main",
  "lanesDir": "~/.claude/lanes/my-project",
  "scheduledTasksDir": "~/.claude/scheduled-tasks",
  "secondReader": {
    "coveredFiles": ".claude/covered-files.json",
    "verifyCommand": null,
    "skill": "the lanes:second-reader skill"
  }
}
```

| Key | What it does | Default |
|---|---|---|
| `owner` | Whose word allows an exception. Appears in messages and in the override comment `# main-push: <owner>'s word`. | `the owner` |
| `protectedBranch` | The branch agents never push to directly. | `main` |
| `lanesDir` | Holds `lanes.json` and one `<slug>.md` per lane. Keep it outside git: session ids are local to one machine. | `~/.claude/lanes/<project folder>` |
| `scheduledTasksDir` | Scheduled task runs pass the lane guard. | `~/.claude/scheduled-tasks` |
| `secondReader.coveredFiles` | A JSON map of area to paths (a path ending in `/` covers a folder). No file, no gate. | `.claude/covered-files.json` |
| `secondReader.verifyCommand` | Optional check that must pass before the read (a model checker, a test target). | none |

`lanes.json` lists your lanes. Each has a `slug`, a `name`, a `title`, a `sessionId` (`null` until the lane has a session) and `keywords` that only that lane's work uses. See [`templates/lanes.json`](templates/lanes.json).

## Keeping state files small

A state file that only grows carries old decisions into work where they no longer apply. Two rules keep it small:

- **A fixed shape, rewritten, with a cap.** Sections: Now, Waiting for the owner, Decisions to keep (dated, with the why), Done this week, Where things are ([`templates/lane-state.md`](templates/lane-state.md)). Each update rewrites the file; nothing is appended. The status line adds `, state file N lines` when the file is over the cap.
- **A trim at every clear.** On `lane: <slug>`, the lane guard tells the model to trim the file before new work, and names the Done items older than 7 days and a file over the cap. The model deletes finished work, checks each decision against the code, and moves rules that will outlive the work to CLAUDE.md or the docs.

Both limits are in `.claude/brain.json`: `"stateFile": { "maxLines": 150, "doneDays": 7 }`. The monthly `dreaming` pass still does the deeper check.

## Status line: see which lane you are typing into

`scripts/statusline.mjs` prints `lane: <name>` in a lane session and nothing elsewhere. It finds the lane by the session id in `lanes.json`, or by the session's first message (`lane: <slug>` or `new: lane <slug>`), so it still works after a `/clear` in the terminal. Idea from [@buswe_com](https://x.com/buswe_com).

A plugin cannot set the status line, and the plugin's folder changes with each version, so add this to `~/.claude/settings.json` (or the project's `.claude/settings.json`). It runs the newest installed copy:

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh -c 'for d in $(ls -d ~/.claude/plugins/cache/lanes/lanes/*/ 2>/dev/null | sort -rV); do [ -f \"${d}scripts/statusline.mjs\" ] && exec node \"${d}scripts/statusline.mjs\"; done; true'"
  }
}
```

`LANES_STATUSLINE_FORMAT` changes the text (default `lane: {name}`; `{slug}` also works). If you already have a status line, call the script from yours and print both. The status line shows in the terminal; the desktop app does not document one.

## What each hook does, and does not do

| Hook | Event | Stops | Does not |
|---|---|---|---|
| `lane-guard.mjs` | UserPromptSubmit | The first message of a new session that matches a lane with a session | Call a model. It matches keywords in code. A tie between two lanes passes. |
| `second-reader-guard.mjs` | PreToolUse (Bash) | `git commit` of a covered file without a `Second-Reader:` line | Prove that the read happened. The line is the session's statement. |
| `main-push-guard.mjs` | PreToolUse (Bash) | An agent's push that writes to the protected branch | Stop a push you type in a terminal. Use server-side protection for that. |
| `lane-pr-guard.mjs` | PreToolUse (Bash) | `gh pr create` in a lane session (Claude desktop app only) | Anything outside the desktop app. |

Every hook fails open: an error of its own lets the action through. A guard that breaks your work is worse than no guard.

## Prior art

These ideas are not new on their own. Anthropic's [long-running agent harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) keeps a progress file between sessions; [Letta's sleep-time compute](https://www.letta.com/blog/sleep-time-compute) consolidates memory away from live work; [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan routes each task to the right playbook; [agent-skills](https://github.com/addyosmani/agent-skills) by Addy Osmani packages engineering workflows as skills. What Lanes adds is the combination: a fixed registry of long-lived sessions, one state file each, and a hook that turns a duplicate session away at its first message.

## Tests

```
node --test tests/*.test.mjs
```

No dependencies. Each hook runs in a temporary git repository with a made-up project config.

## License

MIT
