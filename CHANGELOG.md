# Changelog

## Updating

In Claude Code, then in a shell:

```
/plugin marketplace update lanes
claude plugin update lanes@lanes
```

Then run `/reload-plugins` in each running session, or restart it: a session keeps the hooks it loaded until then. Read the "After updating" lines of each version you skipped.

## 0.3.3 (2026-11-12)

Fixes from an outside review; each one has a regression test (`tests/audit-033.test.mjs`).

- `lane: <slug>` picked the first lane whose name was a PREFIX of the words, so `lane: web-api` could claim the lane `web` and overwrite its id. Now the longest whole-word match wins, punctuation ends a word, and lanes with an empty name or an unsafe slug (like `../x`) are skipped.
- Two sessions claiming lanes at the same moment could lose one claim. The claim now takes a lock file and re-reads `lanes.json` before it writes.
- The push guard missed `git push --all`, `--mirror`, `git --no-pager push`, `git --git-dir=... push`, `/usr/bin/git push` and `git push origin @` on the protected branch.
- The second reader missed covered files reached by a pathspec commit (`git commit <file>`, `git commit -- <file>`), a folder or glob (`git add lib`), a path relative to a `cd`, and `git --no-pager commit`. Git now resolves those paths. It checks every `git commit` in a command, reads the trailer only after the commit (not from an `echo` before it), and reads `-F<file>` and `printf '...\n...'` messages.
- The lane guard stopped a session mid-work when the same words were sent twice, treated a pasted first message that starts with `<` as not typed, and let any short first message through when a scheduled task used the same word. It now reads only the head of the transcript.
- A value of the wrong type in `brain.json` (`"lanesDir": null`) made every hook fail on every call. Each key now falls back to its default.
- The lane PR guard missed `gh -R owner/repo pr create` and a full path to `gh`.
- Hooks have timeouts (5 s for the lane guard, 10 s for the others). The `dreaming` skill runs only when called by name.
- The status line printed `$&` in a lane name as a pattern, and its settings line in the README broke on a home folder with a space. Use the new line from the README.

**After updating:** if you use the status line, replace your `statusLine` command with the one in the README.

## 0.3.2 (2026-11-12)

- **Lanes are never archived, for real.** The Claude desktop app archives a session when a PR it touched closes, through a switch it copies into each session, `auto_archive_on_close`. Unbinding the PR does not change that switch, so the advice in 0.1.0 to 0.3.1 ("add `# lane-pr: unbind`, then unbind the PR") did not protect a lane. The lane PR guard and the `lanes` skill now name the switch.
- New comment `# lane-pr: ok` lets a lane whose switch is off open a PR. `# lane-pr: unbind` still passes.
- `lane: <slug>` in the desktop app now writes the session's id into `lanes.json`. No more copying ids by hand, and a replaced session no longer leaves a stale id that the guard points to.
- `lane: <slug>` reminds the model to check the switch.

**After updating:** in each lane session in the desktop app, turn the switch off once: ask the session to call `mcp__ccd_pr__get_status` and, if `auto_archive_on_close` is true, `mcp__ccd_pr__set_monitor` with `{"auto_archive_on_close": false}`. Only the session can change its own switch, and in auto mode you approve it in that session. No PR needs to be bound. Then send `lane: <slug>` once so the lane claims its id.

## 0.3.1 (2026-11-12)

- The state file cap is in **characters** (`stateFile.maxChars`, 12,000, about 3,000 tokens), not lines. A line cap is dodged by merging bullets into one long line.
- Bullets over `stateFile.maxBulletChars` (300) are counted in the trim note: one fact per bullet.

**After updating:** if you set `stateFile.maxLines` in 0.3.0, replace it with `maxChars`; `maxLines` is no longer read.

## 0.3.0 (2026-11-12)

- State files have a fixed shape: Now, Waiting for the owner, Decisions to keep (dated, with the why), **Done this week** (`- YYYY-MM-DD: ...`), Where things are. Each update rewrites the file; nothing is appended.
- **Trim on clear:** on `lane: <slug>`, the lane guard tells the model to trim the state file before new work, and names Done items older than `stateFile.doneDays` (7) and a file over the cap.
- The status line flags a state file over the cap.

**After updating:** existing state files still work. They take the new shape at their next `lane: <slug>`, or ask each lane to rewrite its file from [`templates/lane-state.md`](templates/lane-state.md). Done items are found only in a section whose title starts with "Done".

## 0.2.0 (2026-11-12)

- A status line that shows which lane a session is (`scripts/statusline.mjs`). A plugin cannot set the status line, so it is one line in your settings: see the README, "Status line".

## 0.1.0 (2026-11-11)

- First release: the lane guard, the lane PR guard, the second reader, the protected-branch push guard, and the `lanes`, `second-reader` and `dreaming` skills.
