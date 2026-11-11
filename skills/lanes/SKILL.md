---
name: lanes
description: Set up and run lanes, one long-lived Claude Code session and one state file per kind of work. Use when the user wants to set up lanes in a project, add or rename a lane, start or resume a lane session ("lane: <slug>"), clear a lane in place, or asks why a new session was stopped by the lane guard.
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
3. Write `lanes.json`. Each lane gets a `slug`, a `name`, a `title` (the session title in the app), `sessionId: null` and 10 to 30 `keywords`: words that only that lane's work uses. Avoid words two lanes share; a tie lets the message through.
4. Write one state file per lane from the template.
5. Tell the user how to start each lane: open a new session, send `new: lane <slug>` as the first message, then put the session's id in `lanes.json`. In the Claude desktop app the id is `CLAUDE_CODE_HOST_SESSION_ID` (`local_...`).

A lane with `sessionId: null` does not block anything.

## How the guard works

The hook `lane-guard.mjs` reads the FIRST message of a new session. When the message matches one lane's keywords better than any other lane's, and that lane has a session, it stops the message and names the session to continue in. Later messages always pass. Scheduled task runs pass.

- `new: ...` starts a new session anyway.
- `lane: <slug>` says "this IS that lane's session", for the first message after a clear. The hook tells the model to read `<slug>.md` first and to set the session title to the lane title.

## Keep a lane healthy

1. At the end of each piece of work, update the lane's state file: Now, Waiting for the owner, Decisions to keep, Where things are. Write it for a reader who knows nothing about the conversation.
2. When the context gets long, or the session starts to repeat old facts: update the state file, then clear the session IN PLACE (`/clear`). Same row, same title. The next message is `lane: <slug>`.
3. Rules that hold for every session go to CLAUDE.md or memory, not to the state file. The state file holds what is in progress.
4. A lane session is never archived. In the desktop app, a session that owns a pull request is archived when the PR closes, so a lane session must not own one. The hook `lane-pr-guard.mjs` stops `gh pr create` in a lane session. Open the PR from a task session, or add `# lane-pr: unbind` to the command and unbind the PR at once.

## When a task is not lane work

A one-off task gets its own session, started with `new:`. It ends with a pull request, and the app archives it when the PR closes.
