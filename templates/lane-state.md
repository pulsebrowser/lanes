# Lane: <Name>

Last updated: <YYYY-MM-DD HH:MM TZ>

<!-- Rewrite this file at each update; never append to the end. Keep it under 12,000 characters (stateFile.maxChars),
     one fact per bullet, each under 300 characters. On each `lane: <slug>` the lane guard names what to cut.
     A fact that git, a PR or the docs already hold is a link here, not a copy.
     A follow-up gets a date: "(due YYYY-MM-DD)" anywhere in its bullet. When the date comes, the status line,
     the conductor and this lane's next message show it. -->

## Now
- What is in progress, with the branch, the PR and the folder it lives in.
- What is deployed, what is merged but not deployed.

## Waiting for <owner>
- Each decision or approval that only the owner can give, in one line, with its link (the PR, the session).
  Delete it when it is given. The conductor lists these for all lanes in one place.

## Decisions to keep
- <YYYY-MM-DD>: the decision, who made it, and why. When the why stops being true, delete the line.
  A rule that will outlive the current work goes to CLAUDE.md or the docs, not here.

## Done this week
- <YYYY-MM-DD>: what finished, in one line, with its PR or commit. Items older than 7 days are deleted on the next clear.

## Where things are
- Files, commands and URLs a fresh session needs on its first minute.
