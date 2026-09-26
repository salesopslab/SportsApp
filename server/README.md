# BetEdge AI — Backend

Aggregates live odds, team stats/history, injuries, and weather into one API,
then uses that data to ground the AI chat so it never has to guess.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env` with real keys:
- `ODDS_API_KEY` — free tier at https://the-odds-api.com
- `SPORTSDATA_API_KEY` — trial at https://sportsdata.io
- `WEATHER_API_KEY` — free tier at https://openweathermap.org/api
- `ANTHROPIC_API_KEY` — https://console.anthropic.com

```bash
npm run dev
```

Server runs on `http://localhost:8080`.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | uptime check |
| GET | `/api/games/:sport` | live odds board (`sport` = `nfl`, `nba`, `mlb`, `ncaaf`, `ncaab`) |
| GET | `/api/dossier/:sport/:gameId?season=2026&week=5` | full matchup dossier: odds + H2H + injuries + weather |
| POST | `/api/chat` | body `{ message, context }` — `context` is a dossier response; the AI answers grounded in it |

## Notes / next steps

- **Venues data** (`src/data/venues.js`) only has 5 sample teams — extend to full league rosters, or replace with a small Postgres table once this leaves prototype stage.
- **Caching** is in-memory (`node-cache`) with a 90-second TTL — fine for one server instance. Move to Redis once you run more than one instance, so all instances share the cache instead of each hitting the upstream API separately.
- **H2H history** is approximated from each team's season schedule since SportsDataIO doesn't expose a dedicated head-to-head endpoint — good enough for MVP, worth revisiting if history depth matters more than freshness.
- **Rate limits**: odds/stats providers bill per request — the cache exists specifically to keep you inside free/cheap tiers while you have low traffic. Watch usage dashboards on both providers early on.
- None of this was tested against live provider responses (this environment has no network access to those domains) — the request shapes match each provider's published docs, but budget time for adjusting field names once you plug in real keys.
