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

Requires Node.js 20 or later on your `PATH`: the hooks are Node scripts. Without Node they cannot run, and the guards do nothing.

In Claude Code:

```
/plugin marketplace add pulsebrowser/lanes
/plugin install lanes@lanes
```

Then ask Claude to set up lanes in your project (the `lanes:lanes` skill walks through it), or copy the files in [`templates/`](templates/) yourself.

In the Claude desktop app, each lane session then turns off its own archive switch once (see "Lanes are never archived").

**Updating:** `/plugin marketplace update lanes` in Claude Code, then `claude plugin update lanes@lanes` in a shell, then `/reload-plugins` in each running session (or restart it). What changed, and what to do after each version: [CHANGELOG.md](CHANGELOG.md).

To work on the plugin itself, clone it and run `claude --plugin-dir ./lanes`.

## Configure

The hooks read one file in your project, `.claude/brain.json`. Every key is optional.

```json
{
  "owner": "Ada",
  "protectedBranch": "main",
  "lanesDir": "~/.claude/lanes/my-project",
  "scheduledTasksDir": "~/.claude/scheduled-tasks",
  "stateFile": { "maxChars": 12000, "maxBulletChars": 300, "doneDays": 7 },
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
| `stateFile.maxChars` | A state file over this many characters is flagged at each `lane: <slug>` and in the status line. | `12000` |
| `stateFile.maxBulletChars` | Bullets longer than this are counted in the trim note. | `300` |
| `stateFile.doneDays` | "Done" items older than this many days are named for deletion. | `7` |
| `secondReader.coveredFiles` | A JSON map of area to paths (a path ending in `/` covers a folder). No file, no gate. | `.claude/covered-files.json` |
| `secondReader.verifyCommand` | Optional check that must pass before the read (a model checker, a test target). | none |

`lanes.json` lists your lanes. Each has a `slug`, a `name`, a `title`, a `sessionId` and `keywords` that only that lane's work uses. Leave `sessionId` `null`: in the desktop app, `lane: <slug>` writes the session's id there itself (0.3.2). In the terminal, set it by hand if you want the lane guard to name the session. See [`templates/lanes.json`](templates/lanes.json).

## The conductor: talk to one session

A conductor is one more lane, with `"role": "conductor"` in `lanes.json`. You type or talk to it; it finds the lane for each request, asks ONE short question when two lanes fit or none does, forwards a full brief to that lane's session with `SendMessage`, and relays the answer. Start it like any lane: a new session, first message `lane: conductor`.

- **Code gives the facts, the model picks the lane.** `scripts/conductor-lanes.mjs` prints each lane's `description`, session and the first lines of its "Now" section. There is no separate classifier: with a handful of lanes, the conductor's own model reads the table and decides (Anthropic's [routing pattern](https://www.anthropic.com/engineering/building-effective-agents), simplest form).
- **Approvals stay in the lane.** A message from another session can never approve anything in Claude Code, so a merge, a deploy or a permission prompt still needs you in that lane; the conductor tells you which one and links it.
- **The keyword guard stays** as the fast, free backstop for new sessions; it never stops the conductor, and it points a stopped session to it.
- **Cost:** two turns per request (the conductor's and the lane's).
- **Routing eval:** `sh tests/conductor-eval.sh` runs a real Claude session in classify-only mode on requests with known lanes (Haiku by default, `LANES_EVAL_MODEL=opus` for more).

## Lanes are never archived

The Claude desktop app can archive a session when a PR it touched merges or closes (its auto-archive setting, in Settings, under Claude Code). That suits a task session and kills a lane. The app copies the setting into each session as the switch `auto_archive_on_close`, and **only the session can turn its own copy off**: `mcp__ccd_pr__set_monitor` with `{"auto_archive_on_close": false}`. Unbinding the PR does not change it.

Each `lane: <slug>` reminds the model to check the switch, and claims the lane in `lanes.json` for that session, so a replaced or restored session never leaves a stale id behind. Tested on 2026-11-12 on six lanes: switch off, a PR closed, every session still active.

**What this relies on.** The per-session switch, the `mcp__ccd_*` tools and the `local_...` session id in `CLAUDE_CODE_HOST_SESSION_ID` are internals of the Claude desktop app. Anthropic does not document them (checked 2026-11-12), so they can change. Where they are missing, these steps are skipped: the lane guard and the lane PR guard do nothing outside the desktop app, and the account setting applies as usual.

## Keeping state files small

A state file that only grows carries old decisions into work where they no longer apply. Two rules keep it small:

- **A fixed shape, rewritten, with a cap.** Sections: Now, Waiting for the owner, Decisions to keep (dated, with the why), Done this week, Where things are ([`templates/lane-state.md`](templates/lane-state.md)). Each update rewrites the file; nothing is appended. One fact per bullet, under 300 characters. The cap is in characters, 12,000 (about 3,000 tokens), not lines: a line cap is dodged by merging bullets into one long line. The status line adds `, state file 22k chars` when the file is over the cap.
- **A trim at every clear.** On `lane: <slug>`, the lane guard tells the model to trim the file before new work, and names the Done items older than 7 days, a file over the cap and the bullets over 300 characters. The model deletes finished work, checks each decision against the code, and moves rules that will outlive the work to CLAUDE.md or the docs.

The limits are in `.claude/brain.json`: `"stateFile": { "maxChars": 12000, "maxBulletChars": 300, "doneDays": 7 }`. The monthly `dreaming` pass still does the deeper check.

## Status line: see which lane you are typing into

`scripts/statusline.mjs` prints `lane: <name>` in a lane session and nothing elsewhere. It finds the lane by the session id in `lanes.json`, or by the session's first message (`lane: <slug>` or `new: lane <slug>`), so it still works after a `/clear` in the terminal. Idea from [@buswe_com](https://x.com/buswe_com).

A plugin cannot set the status line, and the plugin's folder changes with each version, so add this to `~/.claude/settings.json` (or the project's `.claude/settings.json`). It runs the newest installed copy:

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh -c 'exec 3<&0; r=\"$HOME/.claude/plugins/cache/lanes/lanes\"; ls -1 \"$r\" 2>/dev/null | sort -rV | while read -r v; do if [ -f \"$r/$v/scripts/statusline.mjs\" ]; then node \"$r/$v/scripts/statusline.mjs\" <&3; exit; fi; done; true'"
  }
}
```

It reads the plugin cache under `~/.claude/plugins`; if you set `CLAUDE_CODE_PLUGIN_CACHE_DIR`, change the path in the line. On Windows it needs `sh` (Git Bash). `LANES_STATUSLINE_FORMAT` changes the text (default `lane: {name}`; `{slug}` also works). If you already have a status line, call the script from yours and print both. The status line shows in the terminal; the desktop app does not document one.

## What each hook does, and does not do

| Hook | Event | Stops | Does not |
|---|---|---|---|
| `lane-guard.mjs` | UserPromptSubmit | The first message of a new session that matches a lane with a session | Call a model. It matches keywords in code. A tie between two lanes passes. |
| `second-reader-guard.mjs` | PreToolUse (Bash) | `git commit` of a covered file without a `Second-Reader:` line | Prove that the read happened. The line is the session's statement. |
| `main-push-guard.mjs` | PreToolUse (Bash) | An agent's push that writes to the protected branch | Stop a push you type in a terminal. Use server-side protection for that. |
| `lane-pr-guard.mjs` | PreToolUse (Bash) | `gh pr create` in a lane session without `# lane-pr: ok` (Claude desktop app only) | Anything outside the desktop app. The real fix is the session's own switch: see "Lanes are never archived". |

**What the guards are, and are not.** They are guard rails for an honest agent's ordinary commands, not a security boundary. A command written to get around them gets around them: `bash -c "git push origin main"`, a script file, a git alias. Every PreToolUse guard that reads command text has this limit. For a hard rule, use server-side protection (GitHub branch protection, required reviews).

Every hook fails open: an error of its own, or a value of the wrong type in `brain.json`, lets the action through. Each hook also has a timeout (5 s for the lane guard, 10 s for the others), so a hung `git` call cannot stall your session. A guard that breaks your work is worse than no guard.

## Prior art

These ideas are not new on their own. Anthropic's [long-running agent harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) keeps a progress file between sessions; [Letta's sleep-time compute](https://www.letta.com/blog/sleep-time-compute) consolidates memory away from live work; [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (poteto) routes each task to the right playbook; [agent-skills](https://github.com/addyosmani/agent-skills) by Addy Osmani packages engineering workflows as skills. What Lanes adds is the combination: a fixed registry of long-lived sessions, one state file each, and a hook that turns a duplicate session away at its first message.

## Tests

```
node --test tests/*.test.mjs
LANES_ORACLE=1 node --test tests/oracle.test.mjs
```

No dependencies. Each hook runs in a temporary git repository with a made-up project config. The second line lets **git be the judge**: about 1,000 generated push and commit commands run for real against scratch repositories, and each guard must have stopped exactly the ones that moved the protected branch or committed a covered file. It takes a few minutes and runs in CI as its own job.

```
sh tests/live.sh
```

The live test runs the plugin in a **real Claude Code session**: Claude is asked to push to the protected branch, commit a covered file, start lane work in a new session and claim a lane, and the test checks on disk what happened. It first checks that Claude can answer, so a run where Claude never ran fails instead of passing. It needs a signed-in Claude Code and costs a few cents on Haiku, so it is not in CI: run it before a release. `LANES_FROM_GITHUB=1` tests the published plugin instead of this checkout.

## License

MIT
