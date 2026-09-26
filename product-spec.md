# BetEdge AI — Product & Technical Spec
*AI-powered sports betting research platform | v0.1 Draft*

## 1. Vision
A subscription research copilot for sports bettors — not a sportsbook. Users chat or talk with an AI that synthesizes odds, stats, weather, injuries, and matchup history into clear, sourced analysis, so they make better-informed bets on books they already use.

**Sports at launch:** NFL, NBA, MLB, College Football, College Basketball.

## 2. Legal & Compliance (build in from day one)
- 21+ age gate at signup; ID/age verification via provider (e.g. Stripe Identity, Persona)
- Geo-fencing: block/limit access in states where sports betting is illegal
- Prominent disclaimer: "Informational/research tool only — not a sportsbook, does not accept wagers"
- Responsible-gambling resource link (National Council on Problem Gambling: 1-800-522-4700) in footer and settings
- No scraping/publishing unverified personal conduct info about athletes (privacy/defamation risk) — injury & news data only from licensed feeds
- Terms of Service drafted by a lawyer familiar with gambling-adjacent SaaS before public launch

## 3. Users & Plans
| Tier | Price (suggested) | Includes |
|---|---|---|
| Free | $0 | 1 sport, 3 AI queries/day, odds board (15-min delay) |
| Pro | $19.99/mo | All 5 sports, unlimited AI chat + voice, live odds, injury/weather alerts |
| Pro+ | $39.99/mo | Multi-book odds comparison, bet tracking/bankroll tools, priority AI (faster model), early access to new sports |

Billed via **Stripe Billing** (subscriptions, free trial, dunning/failed-payment handling built in).

## 4. Core Features
1. **AI Research Chat** — ask about any upcoming game in plain text or voice; AI pulls live data and gives a sourced breakdown (not a "pick," a breakdown — keeps you on the right side of tipster regulations in most states)
2. **Voice Mode** — speech-to-text in, text-to-speech out, hands-free "what's the line on..." queries
3. **Live Odds Board** — moneyline/spread/total across major books, updated on a schedule matching your data tier
4. **Matchup Dossier** (auto-generated per game): head-to-head history, home/away splits, weather forecast for game time/venue, current injury report, rest/travel schedule, recent form
5. **Alerts** — line movement, injury news, weather changes for saved/followed games
6. **Bet Tracker** (Pro+) — log bets, track ROI/CLV over time, personal bankroll dashboard

## 5. Data Sources
| Need | Provider options | Notes |
|---|---|---|
| Odds (multi-book) | The Odds API, OddsJam | Paid; usage-based pricing, scales with user growth |
| Team/player stats, H2H history | SportsRadar, Stats Perform | Paid, most comprehensive |
| Injuries / official news | SportsRadar Injuries feed, league press feeds | Licensed data only — no gossip/paparazzi sources |
| Weather | OpenWeatherMap / NOAA | Free tier sufficient at launch |
| AI reasoning & chat | Claude API (Sonnet for most queries, faster/cheaper model for simple lookups) | |
| Speech-to-text / text-to-speech | Browser Web Speech API (free, fastest to ship) or Whisper + ElevenLabs (higher quality, added cost) | |

**Note on "player nightlife" data:** dropped from spec — no reliable/legal feed exists; replaced by verified inputs above (injuries, suspensions, rest/travel), which are the actual predictive factors sharp bettors use.

## 6. Technical Architecture
```
[Mobile-friendly Web App (PWA, React)]
        │
[API Gateway / Backend (Node.js or Python/FastAPI)]
   │        │           │            │
[Odds     [Stats/H2H  [Weather    [Claude API
 Service]  Service]    Service]    Orchestrator]
   │        │           │            │
        [Postgres DB]  [Redis cache for live odds]
        │
   [Stripe Billing] [Auth (Clerk/Auth0)] [Push notifications]
```

- **Frontend:** React + PWA for mobile-first responsive experience at launch; React Native wrapper later if App Store/Play Store presence is wanted
- **Backend:** REST/GraphQL API layer; scheduled jobs to poll odds/stats/weather providers and cache in Redis (odds change fast — don't hit AI or DB on every request)
- **AI orchestration layer:** on each user query, backend assembles a structured context (live odds + stats + weather + injuries for the relevant game) and passes it to Claude, which returns the synthesized, sourced answer — this keeps the AI grounded in real data rather than guessing
- **Auth:** Clerk or Auth0 (handles age verification hooks, social login)
- **Payments:** Stripe Billing + Stripe Identity for age/ID verification
- **Hosting:** Vercel/Netlify (frontend) + Render/Fly.io or AWS (backend)

## 7. Core Data Model (simplified)
- `users` (id, email, age_verified, state, subscription_tier)
- `games` (id, sport, home_team, away_team, venue, start_time)
- `odds_snapshots` (game_id, book, moneyline, spread, total, timestamp)
- `game_context` (game_id, weather_json, injury_report_json, h2h_history_json, updated_at)
- `chat_sessions` / `chat_messages` (user_id, game_id?, role, content, timestamp)
- `tracked_bets` (user_id, game_id, bet_type, stake, odds_taken, result)

## 8. Roadmap
**MVP (4–6 weeks):** 1–2 sports (NFL + NBA), odds board, AI text chat grounded in live data, Stripe paywall, responsive web app
**V1 (+4–6 weeks):** Add MLB/CFB/CBB, voice mode, injury/weather alerts, matchup dossiers
**V2 (+6–8 weeks):** Multi-book odds comparison, bet tracker, native mobile app, push notifications

## 9. Success Metrics
- Free → paid conversion rate
- Weekly active users during each sport's season
- AI chat queries per active user (engagement proxy)
- Churn during off-seasons (mitigated by 4-sport, year-round coverage)
- Subscription MRR growth

## 10. Open Decisions for Founder
- Build native app now or web-first? (recommend web-first for speed to market)
- Which odds/stats data provider tier to start with (affects burn rate significantly)
- Whether to pursue sportsbook affiliate partnerships for extra revenue
