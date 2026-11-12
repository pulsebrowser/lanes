---
name: dreaming
description: A monthly consolidation pass over the project's memory, docs, lanes and scheduled watches - check notes against the code, merge duplicates, flag rules that no longer carry load, list stale docs and lanes. Reports and edits notes; never commits. Use when the user asks for a dreaming pass, a memory cleanup, or sets it up as a monthly scheduled task.
disable-model-invocation: true
---

# Dreaming pass

Notes rot. A rule written for a bug that a test now catches still costs context in every session. A path in a note moves and the next session follows it confidently. This pass is the sleep step: check notes against the ground truth, correct errors, merge duplicates, and promote what matters. It runs best as a monthly scheduled task, on its own, away from live work.

## Hard rules

- Never commit, push or deploy. The owner reviews and commits.
- Never delete a note unless the repo, the git log or a newer note proves it wrong. When in doubt, add a `**Verify:** <date>` line instead.
- Never save what the repo already records (code structure, git history). A note records what the code cannot say: why, who decided, what was rejected.
- Never change, pause or delete a scheduled task, and never edit a lane state file. List what you find for the owner.

## Steps

1. **Memory.** Read the memory folder and its index. Merge notes that hold one rule. Fix facts that a newer note or the repo contradicts. Make sure each note has exactly one index line and each index line has a note. For every file path, function or flag a note names, check that it still exists (grep, ls). Then ask of each rule: does it still carry load? A rule with no reason, or a rule that a hook, test or script now enforces, goes on a list for the owner.
2. **Docs.** List docs whose "Last Verified" or "Last Updated" date is older than 90 days (skip history folders: point-in-time records are never rewritten). Read each against the code it describes; fix clear errors and bump the date. List docs nothing links to.
3. **Patterns.** Read the notes written since the last pass. A lesson that two different parts of the work paid for separately is a pattern: propose it, with the evidence from each.
4. **Lanes and watches.** For each lane in `lanes.json`: does the state file exist, and is it older than 14 days? For each scheduled task: its cadence and its end date. A watch with no end date, or past its end date and still on, goes on the list.
5. **Report.** One message under 400 words: what you merged or corrected (file names), stale docs and what changed, proposed patterns, the "still carries load?" list, the lanes and watches list, and the exact list of files you edited.
