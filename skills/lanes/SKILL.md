---
name: lanes
description: 'Set up and run lanes, one long-lived Claude Code session and one state file per kind of work. Use when the user wants to set up lanes in a project, add or rename a lane, start or resume a lane session ("lane: <slug>"), clear a lane in place, or asks why a new session was stopped by the lane guard.'
---

# Lanes

A long session forgets: each compaction keeps a summary of a summary. Fresh sessions multiply: after a week, ten of them each hold part of the story. A lane fixes both. Each kind of work (product, ops, CI, one product among several) gets ONE session that lives for months and ONE state file that the session rereads after every clear.

## The files

- `.claude/brain.json` in the project (in git): the settings the hooks read. Start from `${CLAUDE_PLUGIN_ROOT}/templates/brain.json`.
- `<lanesDir>/lanes.json` (outside git, default `~/.claude/lanes/<project folder>/`): the lanes, with their session ids and keywords. Start from `${CLAUDE_PLUGIN_ROOT}/templates/lanes.json`.
- `<lanesDir>/<slug>.md`: the state of one lane. Start from `${CLAUDE_PLUGIN_ROOT}/templates/lane-state.md`.

Session ids are local to one machine and the state changes every day. Keep both out of git.

## Set up lanes in a project

1. Ask the user which kinds of work they run. Keep the list short: three to six lanes. A lane is a kind of work that comes back every week, not a task.
2. Write `.claude/brain.json` with the owner's name, the protected branch and `lanesDir`.
3. Write `lanes.json`. Each lane gets a `slug`, a `name`, a `title` (the session title in the app), `sessionId: null`, a one-sentence `description` of its work (the conductor routes by it) and 10 to 30 `keywords`: words that only that lane's work uses. Avoid words two lanes share; a tie lets the message through. Optionally add a conductor lane (`"role": "conductor"`, no keywords): one session the owner talks to, which routes each request to a lane (skill `lanes:conductor`).
4. Write one state file per lane from the template.
5. Tell the user how to start each lane: open a new session and send `lane: <slug>` as the first message. In the Claude desktop app the lane guard then writes the session's id (`CLAUDE_CODE_HOST_SESSION_ID`, `local_...`) into `lanes.json` itself. In the terminal, put the id in `lanes.json` by hand, or rely on the status line's first-message match.
6. In the desktop app, each lane session turns off its own archive switch on day one: `mcp__ccd_pr__set_monitor` with `{"auto_archive_on_close": false}`, checked with `mcp__ccd_pr__get_status`. The account setting "archive sessions when their PR closes" is copied into every new session, and only the session can change its copy. Unbinding a PR does not change it. These tools are internals of the desktop app, not documented by Anthropic: if they are not available (the terminal, or a later app version), skip this step and tell the owner; do not guess another way.
7. Offer the lane status line (README, "Status line"): it shows `lane: <name>` in the terminal. Add it to the user's settings only if they say yes, and keep any status line they already have.

A lane with `sessionId: null` does not block anything.

## How the guard works

The hook `lane-guard.mjs` reads the FIRST message of a new session. When the message matches one lane's keywords better than any other lane's, and that lane has a session, it stops the message and names the session to continue in. Later messages always pass. Scheduled task runs pass.

- `new: ...` starts a new session anyway.
- `lane: <slug>` says "this IS that lane's session", for the first message after a clear. The hook tells the model to read `<slug>.md` first, to set the session title to the lane title, and to TRIM the file before new work: it names the Done items older than `stateFile.doneDays` (7) says when the file is over `stateFile.maxChars` (12,000 characters), and counts bullets over `stateFile.maxBulletChars` (300). The model deletes finished work, checks each decision against the code, and moves lasting rules to CLAUDE.md or the docs. Pruning happens at every clear, not once a month.

## Keep a lane healthy

1. At the end of each piece of work, REWRITE the lane's state file (never append to the end): Now, Waiting for the owner, Decisions to keep, Done this week, Where things are. Move what finished from Now to Done this week, as `- YYYY-MM-DD: ...`. Write it for a reader who knows nothing about the conversation. One fact per bullet, under 300 characters. Keep the file under the cap (`stateFile.maxChars`, 12,000 characters, about 3,000 tokens).
2. When the context gets long, or the session starts to repeat old facts: update the state file, then clear the session IN PLACE (`/clear`). Same row, same title. The next message is `lane: <slug>`.
3. Rules that hold for every session go to CLAUDE.md or memory, not to the state file. The state file holds what is in progress.
4. A lane session is never archived. In the desktop app, a session is archived when a PR it touched closes, unless its own `auto_archive_on_close` switch is off (setup step 6; every `lane: <slug>` reminds the model to check it). With the switch off, a lane may open PRs: add `# lane-pr: ok` to `gh pr create`. The hook `lane-pr-guard.mjs` stops `gh pr create` without that comment, as a backup for a lane whose switch is still on.

## Retire a lane

When the owner says a lane's kind of work is gone (not one finished task: that clears in place), retire it. Move the rules in its state file that outlive it to CLAUDE.md or the docs, then run `node "${CLAUDE_PLUGIN_ROOT}/scripts/retire-lane.mjs" <slug>`. It marks the entry retired, clears its session id and moves the state file to `<lanesDir>/retired/`; it never archives a session. Tell the owner they may archive the lane's session in the app. `--undo` brings it back. The owner may archive any session at any time; lanes only keeps a pull request from doing it.

## When a task is not lane work

A one-off task gets its own session, started with `new:`. It ends with a pull request, and the app archives it when the PR closes.
