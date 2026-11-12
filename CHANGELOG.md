# Changelog

## Updating

```
/plugin marketplace update lanes
/plugin update lanes@lanes
```

Then **restart each session**. Claude Code loads hooks when a session starts, so a running session keeps the old ones until it restarts. Read the "After updating" lines of each version you skipped.

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
