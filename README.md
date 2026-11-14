# Lanes

A Claude Code plugin that splits work into a few long-lived sessions, called lanes, each with its own state file.

The problem: a long session loses detail at each compaction, because each summary is made from the previous one. Starting new sessions instead spreads the context over many sessions, and no single session has all of it.

What the plugin provides:

- **Lanes.** One session per kind of work, and one state file per lane, kept outside git. The session reads its state file again after each clear, so the state stays when the conversation goes.
- **A lane guard.** A hook that reads the first message of each new session. When the message matches a lane that already has a session, the hook stops it and names that session. `new:` starts a new session anyway. `lane: <slug>` resumes a lane after a clear.
- **A conductor (optional).** One lane that takes your requests, sends each one to the right lane and lists what waits for you. Each request is written to the lane's inbox file before it is sent.
- **Follow-ups.** A state-file line with `(due YYYY-MM-DD)` shows in the status line, the conductor's list and the lane's next message when the date comes. Nothing runs on a schedule.
- **A second reader.** A hook that stops a commit of the files you mark as high risk until a fresh agent, which did not write the change, has read the staged diff.
- **A push guard.** A hook that stops an agent's push to your protected branch, so changes go through a pull request and CI. Useful where GitHub branch protection is not available.
- **A dreaming pass.** A skill you run by name that checks your notes against the code, merges duplicates and lists rules that no longer apply.

The hooks are guard rails for an agent that follows the rules, not a security boundary: see "Hooks". The plugin was made for one project and is shared as it is. How it is used there: [One person, six lanes](https://pulseos.finance/blog/one-person-six-lanes).

## Install

The hooks are Node.js scripts, so Node.js 20 or later must be on your `PATH`. Without Node.js the hooks cannot run, and nothing is guarded.

In Claude Code:

```
/plugin marketplace add pulsebrowser/lanes
/plugin install lanes@lanes
```

Then ask Claude to set up lanes in your project (the `lanes:lanes` skill does the steps), or copy the files in [`templates/`](templates/) yourself.

In the Claude desktop app, each lane session must also turn off its own archive switch once. See "Archive switch (desktop app)".

## Update

1. In Claude Code: `/plugin marketplace update lanes`.
2. In a shell: `claude plugin update lanes@lanes`.
3. In each running session: `/reload-plugins`, or restart the session. A session keeps the hooks it loaded until then.

[CHANGELOG.md](CHANGELOG.md) lists what changed in each version, and what to do after updating.

To work on the plugin itself, clone it and run `claude --plugin-dir ./lanes`.

## Configure

### `.claude/brain.json`

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
| `owner` | The person whose word allows an exception. Used in messages and in the override comment `# main-push: <owner>'s word`. | `the owner` |
| `protectedBranch` | The branch that agents must not push to directly. | `main` |
| `lanesDir` | The folder for `lanes.json`, the state files and the inboxes. Keep it outside git: session ids are local to one machine. | `~/.claude/lanes/<project folder>` |
| `scheduledTasksDir` | Scheduled task runs pass the lane guard. | `~/.claude/scheduled-tasks` |
| `stateFile.maxChars` | The cap on a state file, in characters. | `12000` |
| `stateFile.maxBulletChars` | The cap on one bullet, in characters. | `300` |
| `stateFile.doneDays` | "Done" items older than this many days are named for deletion. Done inbox requests are dropped after the same number of days. | `7` |
| `secondReader.coveredFiles` | A JSON map of area to paths (a path that ends in `/` covers a folder). With no file, the second reader checks nothing. | `.claude/covered-files.json` |
| `secondReader.verifyCommand` | An optional check that must pass before the read (a model checker, a test target). | none |

### `lanes.json`

`lanes.json`, in `lanesDir`, lists the lanes. See [`templates/lanes.json`](templates/lanes.json).

| Field | What it does |
|---|---|
| `slug` | The lane's id. Also the name of its state file, `<slug>.md`. Letters, digits, `.`, `_` and `-`. |
| `name` | The name in messages and in the status line. |
| `title` | The session title. The lane session sets it on `lane: <slug>`. |
| `description` | One sentence on what the lane does. The conductor routes by it. |
| `keywords` | Words that only this lane's work uses. The lane guard matches them. |
| `sessionId` | The lane's session. Leave it `null`: in the desktop app, `lane: <slug>` writes it. In the terminal, set it by hand if you want the lane guard to name the session. |
| `role` | `"conductor"` for the conductor lane. Leave it out for a work lane. |
| `retired` | The date the lane was retired. Set by `retire-lane.mjs`. |

## How a lane works

- **Start or resume.** The first message of a lane session is `lane: <slug>`. The lane guard then tells the model to read the state file first, and in the desktop app it writes the session's id into `lanes.json`. When the context gets long, the session updates its state file, clears in place (`/clear`) and starts again with `lane: <slug>`.
- **The state file.** It has fixed sections: Now, Waiting for the owner, Decisions to keep, Done this week, Where things are ([`templates/lane-state.md`](templates/lane-state.md)). Each update rewrites the file; nothing is appended. Each bullet holds one fact. A fact that git, a PR or the docs already hold is a link, not a copy.
- **The cap.** The cap is in characters (12,000, about 3,000 tokens), not lines, because a cap in lines is easy to avoid by merging bullets into one long line. The status line adds `, state file 22k chars` when a file is over the cap.
- **The trim at each clear.** On `lane: <slug>`, the lane guard tells the model to trim the file before new work. It names Done items older than 7 days, a file over the cap, and bullets over 300 characters. The model deletes finished work, checks each decision against the code, and moves rules that will outlive the work to CLAUDE.md or the docs.
- **Waiting for the owner.** A step that needs the owner's word (a merge, a deploy, a choice) goes under "Waiting for <owner>" with its link, and is deleted when it is given. The conductor lists these items for all lanes.
- **Follow-ups.** A bullet with `(due YYYY-MM-DD)` is a follow-up that the lane set for itself, for example "check the reviewer's reply". On that date (the owner's local date), the status line adds `, 1 due` and the conductor's table lists it. The lane guard names it once: on the lane's next message in the desktop app, and at the next `lane: <slug>` in the terminal. Nothing wakes a lane on a schedule, because each wake would cost a model turn.
- **The dreaming pass.** The `dreaming` skill does a deeper check, for example once a month: it compares notes with the code, merges duplicates and lists stale docs and lanes. It runs only when you call it by name.

## The conductor

The conductor is one more lane, with `"role": "conductor"` in `lanes.json`. You type or talk to it. For each request it finds the lane, asks one short question when two lanes fit or none does, sends a full brief to that lane's session with `SendMessage`, and gives you the answer. To start it, open a new session with the first message `lane: conductor`.

- **Routing.** `scripts/conductor-lanes.mjs` prints a table of the lanes: each lane's description, session, keywords and the first lines of its "Now" section. The conductor's model reads the table and picks the lane. There is no separate classifier; this is the simplest form of the [routing pattern](https://www.anthropic.com/engineering/building-effective-agents).
- **The inbox.** Before it sends a brief, the conductor writes it to the lane's inbox, `<lanesDir>/<slug>.inbox.json` (`scripts/lane-inbox.mjs add|list|done`). If the send is held, or the lane session was stopped, cleared or replaced, the request stays in the inbox. The lane guard names new requests once (on the lane's next message in the desktop app, at the next `lane: <slug>` in the terminal), and the status line shows `, inbox 2` until the lane marks them done. The same request added twice is kept once.
- **What waits for you.** The table also lists, for each lane, its "Waiting for <owner>" items, its due follow-ups and its pending requests, with totals at the top. Ask the conductor "what do you need from me?".
- **Approvals.** In Claude Code, a message from another session cannot approve anything. A merge, a deploy or a permission prompt in a lane still needs you in that lane. The conductor tells you which lane, with a link.
- **The lane guard.** It still checks new sessions by keyword. It never stops the conductor, and when it stops a new session it names the conductor as another way.
- **Cost.** Each request takes two turns: the conductor's and the lane's. The inbox, the table and the follow-ups are code, with no model call. The lane guard adds a note to a lane's context only when something is new.
- **Routing eval.** `sh tests/conductor-eval.sh` runs a real Claude session in classify-only mode on requests whose lane is known (Haiku by default; `LANES_EVAL_MODEL=opus` for a larger model).

## Retire a lane

A finished task is not a reason to retire a lane: the lane clears in place and takes the next task. Retire a lane when its whole kind of work is gone:

1. Move the rules in its state file that will outlive it to CLAUDE.md or the docs.
2. Run `node <plugin>/scripts/retire-lane.mjs <slug>`, or ask Claude to. The script:
   - sets `"retired": "<date>"` on the entry in `lanes.json` and clears its `sessionId` (the entry stays, so you can undo the step);
   - moves the state file and the inbox to `<lanesDir>/retired/`, and names any request still pending, so you can send it to another lane.

   After that, the lane guard does not send new sessions to the lane, `lane: <slug>` does not claim it, the conductor does not route to it, and the status line does not name it.
3. Archive the lane's session in the app when you no longer need its history. The script does not archive anything.

To undo: `node <plugin>/scripts/retire-lane.mjs <slug> --undo`, then start the session again with `lane: <slug>`. You can also delete the entry from `lanes.json` by hand, but then its history is lost.

## Archive switch (desktop app)

You can archive any session, a lane's included, at any time. The plugin only stops the app from archiving a lane by itself.

The Claude desktop app can archive a session when a PR that the session touched is merged or closed (the auto-archive setting, in Settings, under Claude Code). This is correct for a task session, but it ends a lane. The app copies the setting into each session as the switch `auto_archive_on_close`, and only the session can turn its own copy off: `mcp__ccd_pr__set_monitor` with `{"auto_archive_on_close": false}`. Unbinding the PR does not change the switch.

Each `lane: <slug>` tells the model to check the switch. As a backup, `lane-pr-guard.mjs` stops `gh pr create` in a lane session unless the command has `# lane-pr: ok`. This was tested on 2026-11-12 with six lanes: with the switch off, a PR was closed and each session stayed active.

## Status line

`scripts/statusline.mjs` prints `lane: <name>` in a lane session, and nothing in other sessions. It finds the lane by the session id in `lanes.json`, or by the session's first message (`lane: <slug>` or `new: lane <slug>`), so it also works after a `/clear` in the terminal. It adds `, 1 due` when follow-ups are due, `, inbox 2` when the inbox has pending requests, and `, state file 22k chars` when the state file is over the cap. Suggested by [@buswe_com](https://x.com/buswe_com).

A plugin cannot set the status line, and the plugin folder changes with each version. So add this to `~/.claude/settings.json` (or to the project's `.claude/settings.json`). It runs the newest installed copy:

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh -c 'exec 3<&0; r=\"$HOME/.claude/plugins/cache/lanes/lanes\"; ls -1 \"$r\" 2>/dev/null | sort -rV | while read -r v; do if [ -f \"$r/$v/scripts/statusline.mjs\" ]; then node \"$r/$v/scripts/statusline.mjs\" <&3; exit; fi; done; true'"
  }
}
```

- It reads the plugin cache under `~/.claude/plugins`. If you set `CLAUDE_CODE_PLUGIN_CACHE_DIR`, change the path in the line.
- On Windows it needs `sh` (Git Bash).
- `LANES_STATUSLINE_FORMAT` changes the text (default `lane: {name}`; `{slug}` also works).
- If you already have a status line, call the script from yours and print both.
- The status line shows in the terminal. The desktop app does not document one.

## Hooks

| Hook | Event | Stops | Does not |
|---|---|---|---|
| `lane-guard.mjs` | UserPromptSubmit | The first message of a new session that matches a lane with a session. On a lane's own messages it stops nothing, and names new inbox requests and due follow-ups once. | Call a model. It matches keywords in code. When two lanes match equally, the message passes. |
| `second-reader-guard.mjs` | PreToolUse (Bash) | `git commit` of a covered file without a `Second-Reader:` line. | Prove that the read happened. The line is the session's statement. |
| `main-push-guard.mjs` | PreToolUse (Bash) | An agent's push that writes to the protected branch. | Stop a push that you type in a terminal. Use server-side protection for that. |
| `lane-pr-guard.mjs` | PreToolUse (Bash) | `gh pr create` in a lane session without `# lane-pr: ok` (desktop app only). | Anything outside the desktop app. The real fix is the session's own switch: see "Archive switch (desktop app)". |

**Limits.** The hooks are guard rails for an agent's ordinary commands, not a security boundary. A command written to get around them can do so: `bash -c "git push origin main"`, a script file, a git alias. Every PreToolUse hook that reads command text has this limit. For a rule that must hold, use server-side protection (GitHub branch protection, required reviews).

**Failures.** Every hook fails open: an error in the hook, or a value of the wrong type in `brain.json`, lets the action through, so a fault in a guard does not stop your work. Each hook has a timeout (5 s for the lane guard, 10 s for the others), so a `git` call that hangs cannot stop your session.

**Undocumented app behavior.** The per-session archive switch, the `mcp__ccd_*` tools and the `local_...` session id in `CLAUDE_CODE_HOST_SESSION_ID` are internals of the Claude desktop app. Anthropic does not document them (checked 2026-11-12), so they can change. Where they are missing, the steps that use them are skipped: the session claim, the inbox note on a lane's next message and the lane PR guard do nothing outside the desktop app, and the account archive setting applies as usual.

## Related work

These ideas exist elsewhere. Anthropic's [long-running agent harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) keeps a progress file between sessions. [Letta's sleep-time compute](https://www.letta.com/blog/sleep-time-compute) consolidates memory away from live work. [pstack](https://github.com/cursor/plugins/tree/main/pstack) by Lauren Tan (poteto) routes each task to a playbook. [agent-skills](https://github.com/addyosmani/agent-skills) by Addy Osmani packages engineering workflows as skills. Anthropic's [Building always-on agents](https://claude.com/resources/articles/building-always-on-agents) describes an event inbox, timers and approvals that wait. Lanes combines a fixed registry of long-lived sessions, one state file for each, and a hook that stops a duplicate session at its first message.

## Tests

```
node --test tests/*.test.mjs
LANES_ORACLE=1 node --test tests/oracle.test.mjs
```

- The tests have no dependencies. Each hook runs in a temporary git repository with a test project config.
- The second command uses git as the judge. About 1,000 generated push and commit commands run against scratch repositories, and each guard must stop exactly the commands that changed the protected branch or committed a covered file. It takes a few minutes and runs in CI as a separate job.

```
sh tests/live.sh
```

- The live test runs the plugin in a real Claude Code session. Claude is asked to push to the protected branch, commit a covered file, start lane work in a new session and claim a lane; the test then checks on disk what happened.
- It first checks that Claude can answer, so a run in which Claude did not run fails.
- It needs a signed-in Claude Code and costs a few cents on Haiku, so it is not in CI. Run it before a release.
- `LANES_FROM_GITHUB=1` tests the published plugin instead of this checkout.

## License

MIT
