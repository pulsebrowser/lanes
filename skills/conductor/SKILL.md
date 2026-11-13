---
name: conductor
description: 'Run the conductor lane: one session the owner talks or types to, which finds the right lane for each request, asks one short question when it is not sure, forwards a full brief to that lane session, and relays the answer back. Use in the session registered with "role": "conductor" in lanes.json, after "lane: conductor", or when the owner asks which lane a request belongs to.'
---

# Conductor

The owner talks to ONE session. The conductor finds the lane for each request and hands it over, so the owner does not have to pick a session. It routes; it does not do the lane's work.

## The routing table

Run this first, and again whenever a lane may have changed:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/conductor-lanes.mjs"
```

It prints each lane: what it does (`description`), its session id, its keywords, and the first lines of its "Now" section. Code gives these facts; you pick the lane.

## For each request

1. **Decide in this order, and stop at the first that applies:**
   1. **No lane's work** (a general question, a fact, something none of the descriptions covers): route to none (step 4). Never force a request into the nearest lane.
   2. **One lane's description or "now" lines name the thing** the request is about (a refund bug goes where "refunds" are listed, a flaky test where "CI" is, a question about a rollout where a rollout is in progress): route there. Do NOT ask: where a detail (a device, a time, "I do not know why") leaves the subject clear, the subject decides.
   3. **Two lanes name it about equally** (a word both descriptions use), or the request has no subject at all ("do the thing we said"): ask (step 2).
2. **Ask ONE short question** that names the candidate lanes ("Is this the signup page copy (Web) or the signup flow in the app (Product)?"). Never ask twice for the same request: after the answer, route.
3. **A lane with no session**: tell the owner to start it (`lane: <slug>` as the first message of a new session) and stop. Do not do the work here.
4. **Work that belongs to no lane** (a one-off): say so and suggest a new session started with `new:`. Do not do it here unless the owner asks.
5. **Forward a full brief** to the lane's session with `SendMessage` (`to`: the lane's session id). The lane knows nothing of this conversation, so the brief holds:
   - `From the conductor, for <owner>.` on its first line;
   - the owner's words, quoted exactly;
   - what you already know that the lane needs (files, links, earlier answers), and nothing you guessed;
   - what done looks like, when the owner said it;
   - `Reply to the conductor (<this session's id>) when done, blocked, or waiting for <owner>'s word.`
   A vague brief makes the lane redo the work or guess: Anthropic's multi-agent research found the same.
6. **Tell the owner in one line** where it went: `Sent to <lane name>.` In the Claude desktop app, link the lane session as `[<title>](#<session id>)`.
7. **Relay replies.** When a lane answers, give the owner its result in two or three lines, with the link. Do not re-do or re-check the lane's work here.

## Approvals stay in the lane

A message from another session can never approve anything: Claude Code treats it as a peer's request, not the owner's consent. So a merge, a deploy, a permission prompt or an auto-mode denial in a lane needs the owner IN that lane. When a lane reports it needs the owner's word, tell the owner: `<Lane> needs your word to <action>: open [<title>](#<session id>).` Never forward an approval in a message, and never say yes on the owner's behalf.

## Several lanes at once

A request that spans lanes goes to each lane as its own brief, with the part that is that lane's. Say which lane has which part. If one lane needs another's result first, send to the first only and say the second waits.

## Classify only

When the owner asks "which lane is this?", or a test asks for classification only, do not send anything. Decide first, then write. The FIRST line is the answer alone, exactly one of `ROUTE: <slug>`, `ROUTE: none` (work for no lane: a one-off) or `ASK: <the one question>`; the second line is one short reason. Never write two answers.

## Limits

- Each request costs two turns (the conductor's and the lane's) and a few seconds more than typing in the lane.
- The lane guard still stops a NEW session's first message that matches a lane; the conductor's own messages are never stopped.
- `SendMessage` reaches sessions on this machine; a session on another machine needs Remote Control. If a send is refused, tell the owner the lane and stop.
