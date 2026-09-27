# Disneyland "next ride" app

## Justin's request (2026-09-26, verbatim)

> "I want to know if it's possible to build a disneyland-optimizing application that can use the
> current wait times of rides at disneyland, along with our GPS location and a list of the rides we
> want to go on to tell us the next ride we should go on at a given moment. If that real-time
> information is available, start a new conversation that can help build that app."

## Real-time data: confirmed available (Fleet checked live on 2026-09-26)

- **ThemeParks.wiki API:** `https://api.themeparks.wiki/v1/entity/disneylandresort/live`. This is free and needs
  no key. It covers both parks (Disneyland and DCA) and returns standby wait, status (OPERATING/DOWN/CLOSED)
  and lastUpdated, plus **Lightning Lane return times and paid LL prices**. It also has entity
  metadata, including lat/long per attraction (`/v1/entity/{id}` and `/children`) and schedules (`/schedule`).
  Fleet's fetch returned data a few minutes old (for example, Space Mountain at 65 min).
- **Queue-Times:** `https://queue-times.com/parks/16/queue_times.json` (Disneyland) and `/parks/17/` (DCA).
  It's simpler, updates every ~5 minutes, and serves as a fallback. Their terms require a visible
  "Powered by Queue-Times.com" credit.
- Check each API's CORS and terms before relying on it from the browser. If CORS blocks a call, put
  a tiny proxy or cache in front of it.

## What to build

A **phone-first web app** (it will be used standing in the park, on cellular, one-handed) that:
1. Lets us pick the rides we want today (both parks) and mark each one done as we ride it.
2. Uses the phone's **GPS** (browser geolocation) for where we are now.
3. Pulls **live waits** and answers one question: **"what should we ride next?"** It shows the top pick
   and a couple of alternatives, each with a one-line reason (for example, "15 min wait, 4 min walk, usually 60+
   by 2pm").

Design questions this session owns. Decide them sensibly and don't ask Justin to approve them:
- The scoring model: current wait + walking time (a walking graph or a straight-line estimate with a
  path factor), plus how the wait is likely to trend later today (historical averages, if a source exists),
  closing time, rides that are down, and the park-hopping cost between Disneyland and DCA.
- Lightning Lane: at least surface return times. Whether to plan around LL is a good follow-up.
- Where it's hosted, so Justin can open it on his phone. Pick something free and simple, and tell him the URL.
- Offline and bad-signal behaviour: it should show the last-known waits with their age, never a spinner.

## How Justin wants it

- Per `~/.claude/CLAUDE.md`: **don't gate on design approval. Build it, and he tests it.** Ask only
  genuinely ambiguous questions that change what gets built.
- This is a design with no existing pack, so do the design pass carefully (the model/effort
  table in `~/.claude/CLAUDE.md`), then implement. Opus subagents at medium/high are fine for bounded
  implementation from your spec.
- Test at phone width. Any hover UI follows the hover-reach rule, though a phone app should barely have any.
- Deliverables and write-ups are **HTML**, with full `file:///` links. Give Justin forward-slash paths for
  anything he runs.
- Keep a QUEUE.md in `~/.claude/projects/<this project's slug>/` once there's more than one outstanding ask.
- Deploying to a public URL is fine for a personal tool with no secrets. Say what you deployed and where.
- Fleet Commander (`E:\src\claude-fleet`) routes between Justin's sessions.
