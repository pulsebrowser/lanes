---
name: second-reader
description: A fresh agent that did not write a change reads the staged diff before a commit of a covered file (the list is `secondReader.coveredFiles` in .claude/brain.json). Use before git commit when the staged change touches a covered file, and when the commit hook stops a commit with "a second reader is necessary".
---

# Second reader

A session that wrote a change is a weak judge of that change. It reads what it meant to write. A fresh agent reads what is there. This step gives each change to the riskiest files (money, auth, consent, data deletion: whatever the project lists) one reader that did not write it.

The hook `second-reader-guard.mjs` stops a commit of a covered file when the message has no `Second-Reader:` line.

## Order

1. Stage the files by name.
2. If `.claude/brain.json` sets `secondReader.verifyCommand`, run it for the area. It must pass.
3. Do the second read (below).
4. Fix or answer each finding. Each fixed finding gets a test that FAILS on the code before the fix: run it there once. If a fix changes a covered file, run step 2 again.
5. If step 4 changed code, do ONE more second read, of the fix diff only (`git diff` of the fixes). Fixes are where new bugs live. Skip it when no finding needed a code change.
6. Commit with the `Second-Reader:` line.

## The second read

Start ONE helper agent (a general-purpose subagent). Give it only these items:

- the command to read the change: `git diff --cached` in the working directory (give the absolute path);
- the area's rules, if the project has a file for them;
- the task text below.

Do NOT give the agent your summary, your reasons or your conclusion. An agent that gets your conclusion returns it confirmed.

Task text for the agent:

> You are the second reader of a staged change. You did not write it. Run `git diff --cached` in `<absolute path>`. Read the area's rules in `<rules path>` if one is given. Open each changed file in full, not only the diff lines.
> Try to show that the change is wrong. Look for: a rule the change breaks; a status write that does not name the state it leaves; a lock that a non-owner can release; money that is charged twice or not at all; data that reaches a person or a model that must not see it; a path that returns made-up data when real data is missing; a test or a check that the change weakens.
> Report each finding as: file and line, what is wrong, and a concrete input or order of steps that makes it fail. When you can, RUN that input (a test, a script, a command in a temporary copy) and say CONFIRMED with what you saw. Say PLAUSIBLE if you only reasoned it. If you find nothing, say so in one line and list what you checked. Do not edit files. Do not commit.

## After the read

- A CONFIRMED finding: fix it, or show from the code why it is not a failure. Do not ignore it.
- A PLAUSIBLE finding: trace it. Then treat it as above.
- A finding about a weakened test or check: put the rule back. Never weaken a rule to pass.

Tell the owner the count and the findings when you ask for their word to commit.

## The line in the commit message

Put one line in the message body:

```
Second-Reader: fresh agent, 2 findings, 2 fixed, fixes read again: clean
Second-Reader: fresh agent, no findings
Second-Reader: fresh agent, 3 findings, 2 fixed, 1 answered (not a failure: the row is locked)
```

Write only what happened. A false line is worse than no line.

## To skip the step

Only the owner (`owner` in .claude/brain.json) can skip it, for one commit, with their word in the conversation. Then write `Second-Reader: skipped on <owner>'s word`.

## Limits

- The hook checks agent sessions. A commit that a person types in a terminal does not go through it.
- The read finds errors of logic. It does not replace tests or CI.
- One fresh agent costs one more agent run for each commit of a covered file, two when its findings changed code.
