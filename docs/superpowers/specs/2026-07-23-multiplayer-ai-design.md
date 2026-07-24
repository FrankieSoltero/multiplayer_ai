# Multiplayer AI — Research + Proof-of-Concept Design

**Date:** 2026-07-23
**Status:** Approved by user
**Goal:** Startup exploration of YC's Fall 2026 "Multiplayer AI" RFS (author: Aaron Epstein), targeting the engineers/coding vertical.

## Context

YC's RFS: "Working with AI is largely single-player... Anyone on a team should be able to drop into the same live agent session to watch it work, redirect it, and hand it off, the way they'd work with any other human team member." Analogy: Figma beat Photoshop and Google Docs beat Word by going multiplayer.

User profile: full-stack web developer (TypeScript/Node/React). Initial instinct was a C-based multithreaded session manager; design analysis concluded agent sessions are I/O-bound (waiting on LLM streams, tool calls, humans), so an event-loop architecture in Node fits the workload and the user's skills. C approach considered and rejected (no LLM/WebSocket ecosystem, thread-per-session wastes memory, weeks of infra work with no product payoff).

## Deliverables

1. **Research report** — `Docs/research-report.md`
2. **Proof-of-concept** — `poc/` — two browser tabs sharing one live agent session

Chosen approach: **Approach A** (self-hosted Node/TS + WebSockets) for local PoC, with **Approach B** (Cloudflare Durable Objects / managed real-time infra) documented as the production evolution path.

## Repo layout

```
multiplayer_ai/
├── Docs/                    # research report + mistakes/fixes log
│   └── research-report.md
├── docs/superpowers/specs/  # this design doc
└── poc/
    ├── server/              # Node + TypeScript session hub
    └── client/              # React + Vite session view
```

## Deliverable 1: Research report

`Docs/research-report.md`, four parts:

1. **The opportunity** — what the RFS asks for; why multiplayer won prior tool generations (Figma/Docs precedent); why agents make it newly relevant (multi-day autonomous tasks need watching, redirecting, handoff).
2. **Competitive landscape** — who is building shared agent sessions for dev teams: Cursor, Devin, Claude Code (teams/cloud sessions), Factory, Amp, OpenAI Codex cloud tasks, and recent YC batch companies chasing this RFS. For each: what is actually multiplayer vs. single-player-with-sharing; where the gaps are.
3. **Technical feasibility** — event-log session architecture; turn-taking vs. CRDT concurrency; what the PoC demonstrated; production requirements (Durable Objects persistence, auth, hibernation for multi-day sessions).
4. **Go/no-go assessment** — open wedges; moat risk (incumbents adding multiplayer as a feature); concrete recommendation.

Research method: parallel web-research agents across companies/topics, then synthesis. Focus is product-and-technical; funding/market-size data included where it surfaces naturally but not a primary axis.

## Deliverable 2: PoC architecture

### Server (Node + TypeScript, single process)

- **Session manager** — in-memory `Map<sessionId, Session>`. Each `Session` owns an append-only **event log** (the core primitive). Every event has a monotonic sequence number and a type:
  `user_message`, `agent_text_delta`, `tool_call`, `tool_result`, `control_change`, `presence_join`, `presence_leave`, `agent_error`.
- **Agent driver** — drives Claude via the Claude Agent SDK within the session; every streamed token/tool-call is appended to the event log.
- **WebSocket hub** — each appended event is broadcast to all clients connected to that session. Late joiners replay the log from sequence 0, then stream live. Reconnects resume from last-seen sequence number.

### Control model (the multiplayer mechanic being proven)

- One participant holds the **steering wheel** — only they can send prompts/redirects to the agent.
- Anyone can **take the wheel** with one click (grab-based; no approval flow in PoC).
- Everyone sees everything live: agent stream, who is driving, who is present.

### Client (React + Vite)

Single session view: shared agent transcript streaming in, participant avatars, driving indicator, take-the-wheel button, prompt box enabled only for the driver. Demo = two browser tabs on one session.

### Security basics

- API key via `.env` (gitignored); no hardcoded secrets.
- Input length limits on user messages.
- No PII logging.
- Auth is **out of scope** for the local PoC; documented in the report as a production requirement.

## Error handling

- Agent/API failures become `agent_error` events in the log — visible to all participants; session survives; driver can retry.
- Server restart loses in-memory sessions — accepted for PoC; report documents that production fixes this with Durable Objects persistence.

## Testing

- **vitest**: event-log ordering; late-joiner replay correctness; steering-lock transfer rules.
- **Acceptance test**: two tabs, one session — tab B watches tab A's agent stream live; tab B takes the wheel and redirects the agent mid-task.

## Out of scope (PoC)

- Authentication/authorization, persistence across restarts, CRDT-style concurrent editing, more than one agent per session, deployment. These are production concerns captured in the report's feasibility section.

## Production evolution path (Approach B, later)

Same event-log design, with each session living in a Cloudflare Durable Object (or equivalent): per-session isolation, WebSocket fan-out, storage persistence, and hibernation for multi-day sessions.
