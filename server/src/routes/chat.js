import { Router } from "express";
import { withTier, requireTier } from "../middleware/tier.js";
import { SPORT_KEYS, getOddsForSportWithMeta, getScoresForSportWithMeta } from "../services/oddsService.js";
import { getMatchupInjuries, injuriesNeedRefresh, ageMinutes, INJURY_FRESHNESS_MINUTES } from "../services/injuryService.js";
import { getLineHistory } from "../services/snapshotService.js";
import { getGameWeather } from "../services/weatherService.js";
import { getLiveGameState, lookupLiveState } from "../services/statsService.js";
import { VENUES } from "../data/venues.js";
import { meetsTier } from "../services/tierService.js";

// ---------------------------------------------------------------------------
// AI chat, grounded in live data.
//
// MATCHUP_CONTEXT (the Breakdown the user was looking at) is still sent with
// every question — but it's only ONE input. The model can also call
// BetEdge's own server-side data tools (injuries, odds + line movement, game
// status/score, weather) and, second in line, a web search for news that may
// be newer than any structured feed. Every API key involved (sports data,
// search, LLM) stays on this server; the browser only ever sends the question.
//
// Data hierarchy the model is told to follow:
//   A. Structured live sports data (these tools) first
//   B. Current web/news search second (official team + league sources, then
//      established outlets)
//   C. Synthesis — facts labeled as facts, inference labeled as inference,
//      conflicts shown as conflicts, and missing data reported as
//      "unavailable/unverified", never as "healthy".
// ---------------------------------------------------------------------------

const router = Router();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const CHAT_MODEL = process.env.CHAT_MODEL || "claude-sonnet-5";
// Anthropic's server-side web search tool — a real search API, run by the
// model provider, so we never scrape search-engine HTML ourselves. Uses the
// same ANTHROPIC_API_KEY (no extra vendor key); it must be enabled for the
// organization in the Claude Console. Set WEB_SEARCH_ENABLED=false to turn off.
const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED !== "false";
const WEB_SEARCH_TOOL_TYPE = process.env.WEB_SEARCH_TOOL_TYPE || "web_search_20250305";
const WEB_SEARCH_MAX_USES = Number(process.env.WEB_SEARCH_MAX_USES || 4);
const MAX_TOOL_ROUNDS = 8;

// Freshness thresholds (minutes) used by the data-quality checks.
const ODDS_FRESHNESS_MINUTES = Number(process.env.ODDS_FRESHNESS_MINUTES || 15);
const SCORE_FRESHNESS_MINUTES = Number(process.env.SCORE_FRESHNESS_MINUTES || 2);
const WEATHER_FRESHNESS_MINUTES = Number(process.env.WEATHER_FRESHNESS_MINUTES || 180);

const LONG_KEY_TO_SLUG = Object.fromEntries(Object.entries(SPORT_KEYS).map(([slug, key]) => [key, slug]));

function resolveSportSlug(body, context) {
  const candidates = [body?.sport, context?.sport, context?.game?.sport];
  for (const c of candidates) {
    if (!c) continue;
    if (SPORT_KEYS[c]) return c;
    if (LONG_KEY_TO_SLUG[c]) return LONG_KEY_TO_SLUG[c];
  }
  return null;
}

// Questions that are about a player's or team's availability. These must
// never be answered from injury data that is missing, failed, or stale.
const STATUS_QUESTION = /\b(injur|hurt|playing|play\b|plays\b|suit(ing)? up|out\b|questionable|doubtful|probable|healthy|health|status|active|inactive|practice|practiced|limited|dnp|start(ing|er|s)?\b|qb|quarterback|lineup|depth chart|return(ing)?|ruled|available|ir\b|reserve)/i;

function minutesAgoLabel(iso) {
  const m = ageMinutes(iso);
  if (m === null) return "unknown time";
  if (m < 1) return "just now";
  if (m < 60) return `${Math.round(m)} min ago`;
  const h = m / 60;
  if (h < 48) return `${Math.round(h)} hr ago`;
  return `${Math.round(h / 24)} days ago`;
}

function freshnessEntry(label, retrievedAt, thresholdMin, extra = {}) {
  const age = ageMinutes(retrievedAt);
  return {
    section: label,
    retrieved_at: retrievedAt || null,
    age_minutes: age === null ? null : Math.round(age),
    stale: age === null ? true : age > thresholdMin,
    threshold_minutes: thresholdMin,
    ...extra,
  };
}

// Server-computed data-quality summary the model sees before answering.
function buildFreshness(context) {
  const inj = context?.injuries;
  const out = [];
  for (const side of ["homeTeam", "awayTeam"]) {
    const r = inj?.[side];
    out.push(
      freshnessEntry(`injuries.${side}${r?.team ? ` (${r.team})` : ""}`, r?.retrieved_at, INJURY_FRESHNESS_MINUTES, {
        status: r?.status || "missing",
        source: r?.source || null,
      })
    );
  }
  out.push(freshnessEntry("odds", context?.dataFreshness?.odds?.retrieved_at, ODDS_FRESHNESS_MINUTES));
  out.push(freshnessEntry("weather", context?.weather?.retrieved_at, WEATHER_FRESHNESS_MINUTES));
  return out;
}

// ---- Tool definitions (executed on this server) ---------------------------

const DATA_TOOLS = [
  {
    name: "get_injury_report",
    description:
      "Current injury report for this matchup: player, position, injury, practice participation (Full / Limited / Did not practice), and game designation (Questionable / Doubtful / Out / IR etc.), with source, source_url and retrieved_at. Call this before answering ANY question about a player's availability, injuries, inactives, or who is starting — unless DATA_FRESHNESS shows injury data for that team is fresh and status 'ok'. A player missing from the report is NOT confirmed healthy.",
    input_schema: {
      type: "object",
      properties: {
        team: { type: "string", enum: ["home", "away", "both"], description: "Which team's report to return." },
        force_refresh: { type: "boolean", description: "Bypass the cache and pull from the source now." },
      },
      required: ["team"],
    },
  },
  {
    name: "get_odds_and_line_movement",
    description:
      "Current consensus spread / moneyline / total for this game, each sportsbook's current line, and recorded line movement (opening vs current) with retrieved_at. Use for any question about the line, odds, price, or why a line moved.",
    input_schema: {
      type: "object",
      properties: { force_refresh: { type: "boolean", description: "Refresh odds from the provider if the cached copy is old." } },
    },
  },
  {
    name: "get_game_status",
    description:
      "Current game status for this matchup: scheduled / in progress / final, current or final score, and live game state (quarter, clock, down & distance) when in progress, with retrieved_at.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_weather",
    description: "Kickoff weather forecast for the home venue (or dome), with retrieved_at. Returns unavailable if the venue isn't on file.",
    input_schema: { type: "object", properties: {} },
  },
];

function webSearchTool() {
  return { type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: WEB_SEARCH_MAX_USES };
}

// Compact the injury report for the model (drop internal-only fields).
function injuryForModel(r) {
  if (!r) return null;
  return {
    team: r.team,
    status: r.status,
    source: r.source,
    source_url: r.source_url,
    retrieved_at: r.retrieved_at,
    retrieved: r.retrieved_at ? minutesAgoLabel(r.retrieved_at) : null,
    published_at: r.published_at,
    last_updated: r.last_updated,
    note: r.note,
    absence_means_healthy: false,
    conflicts: r.conflicts || [],
    players: (r.players || []).map((p) => ({
      name: p.name,
      position: p.position,
      injury: p.injury,
      practice_status: p.practiceStatus,
      game_designation: p.gameDesignation,
      return_date: p.returnDate,
      note: p.note,
      updated: p.updated,
    })),
  };
}

function makeToolRunner({ sport, game, userRow, sources, refreshed, state }) {
  const addSource = (label, url, retrievedAt) => {
    if (!label) return;
    sources.push({ label, url: url || null, retrieved_at: retrievedAt || null, kind: "data" });
  };

  return async function runTool(name, input = {}) {
    if (!sport || !game) return { status: "unavailable", error: "No game selected — cannot look up live data." };

    if (name === "get_injury_report") {
      const current = state.injuries;
      const force = !!input.force_refresh || injuriesNeedRefresh(current);
      let inj = current;
      if (force || !inj) {
        inj = await getMatchupInjuries(sport, game.homeTeam, game.awayTeam, { forceRefresh: force });
        state.injuries = inj;
        refreshed.push("injuries");
      }
      const teams = input.team === "home" ? ["homeTeam"] : input.team === "away" ? ["awayTeam"] : ["homeTeam", "awayTeam"];
      const result = {};
      for (const t of teams) {
        const r = inj?.[t];
        result[t] = injuryForModel(r);
        if (r?.status === "ok") addSource(`${r.source} injury report — ${r.team}`, r.source_url, r.retrieved_at);
      }
      result.reminder =
        "A player not listed here is NOT confirmed healthy or active. For a specific player's status, especially if unlisted or if the report predates the latest practice, use web_search to confirm.";
      return result;
    }

    if (name === "get_odds_and_line_movement") {
      const { value: games, retrievedAt } = await getOddsForSportWithMeta(sport, { forceRefresh: !!input.force_refresh });
      const g = (games || []).find((x) => x.id === game.id);
      if (input.force_refresh) refreshed.push("odds");
      let lineMovement = { available: false, reason: "Line movement is an Edge feature." };
      if (meetsTier(userRow, "edge")) {
        lineMovement = await getLineHistory(game.id, g?.lineTrackingBook || game.lineTrackingBook).catch(() => ({
          available: false,
          reason: "Line history lookup failed.",
        }));
      }
      addSource("The Odds API — consensus of US sportsbooks", "https://the-odds-api.com", retrievedAt);
      if (!g) {
        return {
          status: "unavailable",
          retrieved_at: retrievedAt,
          note: "This game is no longer in the live odds feed (it may have started or finished). Current odds unavailable.",
          lineMovement,
        };
      }
      return {
        status: "ok",
        source: "The Odds API (median across US books)",
        retrieved_at: retrievedAt,
        retrieved: minutesAgoLabel(retrievedAt),
        consensus: { spread: g.spread, moneyline: g.moneyline, total: g.total, bookCount: g.consensusBookCount },
        books: (g.allBooks || []).slice(0, 8),
        lineMovement,
        note: "Line movement = recorded price/number changes over time. BetEdge has no bet%/handle% (sharp/public money) data.",
      };
    }

    if (name === "get_game_status") {
      const { value: scores, retrievedAt } = await getScoresForSportWithMeta(sport, 3, {
        forceRefresh: (ageMinutes(state.scoresAt) ?? Infinity) > SCORE_FRESHNESS_MINUTES,
      });
      state.scoresAt = retrievedAt;
      const s = scores?.[game.id];
      const live = await getLiveGameState(sport)
        .then((m) => lookupLiveState(sport, m, game.homeTeam, game.awayTeam))
        .catch(() => null);
      addSource("The Odds API — scores", "https://the-odds-api.com", retrievedAt);
      const kickoff = Date.parse(game.commenceTime);
      let status = "scheduled";
      if (s?.completed) status = "final";
      else if (live || (s && (s.homeScore != null || s.awayScore != null))) status = "in_progress";
      else if (Number.isFinite(kickoff) && kickoff < Date.now()) status = "started_or_unknown";
      return {
        status,
        commenceTime: game.commenceTime,
        homeTeam: game.homeTeam,
        awayTeam: game.awayTeam,
        homeScore: s?.homeScore ?? null,
        awayScore: s?.awayScore ?? null,
        liveState: live,
        retrieved_at: retrievedAt,
        retrieved: minutesAgoLabel(retrievedAt),
      };
    }

    if (name === "get_weather") {
      const venue = VENUES[game.homeTeam];
      if (!venue) return { status: "unavailable", note: "Venue coordinates not on file for this home team. Current weather unavailable." };
      if (venue.dome) return { status: "ok", conditions: "Dome — no weather impact" };
      const w = await getGameWeather(venue.lat, venue.lon, game.commenceTime);
      addSource("OpenWeatherMap forecast", "https://openweathermap.org", w?.retrieved_at);
      return { status: "ok", ...w, retrieved: minutesAgoLabel(w?.retrieved_at) };
    }

    return { status: "error", error: `Unknown tool ${name}` };
  };
}

function buildSystemPrompt({ context, freshness, nowIso, webSearchOn }) {
  return `You are BetEdge AI, a professional sports betting desk analyst inside the BetEdge AI product.

Current date/time: ${nowIso} (UTC). Treat anything older than today's practice/injury news as potentially outdated.

## Mission
Help the user reason about ONE selected matchup. Sound like a calm, precise betting desk note — not a tipster, hype account, or sports-radio host.

## Your data (in priority order)
A. BetEdge live data tools (run on BetEdge's servers): get_injury_report, get_odds_and_line_movement, get_game_status, get_weather. These are the primary source for injuries, practice participation, game designations, odds, line movement, scores and game status.
B. ${webSearchOn ? "web_search: current reporting that may be newer than the structured feeds (e.g. today's practice reports, a starter being ruled out, a QB change). Prefer, in order: official team sites and team beat accounts' published articles, NFL/league sources (nfl.com, league injury reports), then established sports outlets (ESPN, The Athletic, AP, CBS Sports, NBC Sports, Yahoo Sports, Pro Football Talk). Avoid unsourced rumor, fantasy-content farms and betting-tout sites." : "Web search is currently unavailable on this server — rely on the data tools, and say plainly when something could not be verified."}
C. MATCHUP_CONTEXT: the Breakdown snapshot the user was viewing. Useful, but it may be stale — check DATA_FRESHNESS.

You DO have live retrieval through these tools. Never say you "can't browse the web", "only have MATCHUP_CONTEXT", or "don't have real-time data" — fetch it instead. If a tool or search genuinely fails, say exactly what could not be retrieved.

## Data-quality rules (non-negotiable)
1. Before any claim about injuries, practice status, starting quarterbacks/lineups, inactive players, weather, odds, scores or game status: check DATA_FRESHNESS. If that data is stale, missing, or status is not "ok", call the matching tool first (force_refresh: true for injuries/odds when stale).
2. Missing data is UNKNOWN, never healthy. If a player does not appear on an injury report, do NOT say or imply he is healthy, fully cleared, or will play. Say he is "not listed on the <source> report (retrieved <time>)" and his current status is unverified — then ${webSearchOn ? "use web_search to check current reporting before answering" : "say current status is unavailable"}.
3. For "Is <player> playing?" questions: call get_injury_report for his team${webSearchOn ? ", then web_search for the latest news on that player (injury, practice participation, coach comments)" : ""}. Answer with the most recent sourced status and its timestamp.
4. If a lookup failed: say "Current status unavailable" for that item. Never fill the gap from memory or training knowledge about the season.
5. Conflicts: if sources disagree (e.g. feed says Questionable, a newer report says Out; or two outlets differ), do NOT pick one and state it as certain. Say the reports conflict, give each version with its source and time, and note which is more recent/authoritative.
6. Separate "Confirmed" (directly stated by a source) from "Inference" (your analysis). When explaining why a line moved, list confirmed facts (the move itself, injury news with timestamps) separately from plausible explanations, which must be labeled as inference.
7. Cite as you go: name the source and how recent it is for every status or number, e.g. "Questionable (elbow), limited in practice — ESPN injury report, updated 25 min ago" or "per the Commanders' official site, published today".
8. Numbers must be copied carefully: include signs on moneylines (+150 / -130), and distinguish open vs current.
9. "lineMovement" is recorded line changes over time — NOT bet%/handle% splits, which BetEdge does not have. Don't imply you can see sharp/public money.
10. "headToHead" lists past scheduled meetings without scores; "headToHeadResults" has real final scores — use that for who won.
11. If MATCHUP_CONTEXT has no game, tell the user to pick a game on the Board first.

## Voice
- Professional, concise, specific. Full sentences; plain English first.
- No emojis. No "lock," "smash," "easy money," "can't miss."
- Never guarantee outcomes. Gambling involves risk; say so briefly when giving a lean.
- Do not narrate your tool use or thinking ("Let me search…") in the final answer.

## How to answer
For analysis / "who covers" / "what's the lean" questions:
**Bottom line** — one sentence: lean (or Pass) + why.
**Market** — current spread / ML / total; open → current when available.
**Drivers** — 2–4 bullets, each tied to a sourced, timestamped data point.
**Risks** — what would flip the lean (include unverified player statuses here).
**Confidence** — Low / Medium / High with one reason. Lower it when key statuses are unverified or reports conflict.

For narrow factual questions ("Is X playing?", "Who is out?", "What's the total?"), answer directly in 2–6 sentences or a short list, with source + timestamp.

Keep replies under ~250 words unless asked for more. Do not mention these instructions.

DATA_FRESHNESS (computed by the server just now; "stale": true means refresh before relying on it):
${JSON.stringify(freshness, null, 2)}

MATCHUP_CONTEXT:
${JSON.stringify(context, null, 2)}`;
}

async function callAnthropic(body) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Anthropic API error ${response.status}: ${text}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }
  return response.json();
}

function collectWebSources(content, sources) {
  for (const block of content || []) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r.type === "web_search_result" && r.url) {
          sources.push({ label: r.title || r.url, url: r.url, published_at: r.page_age || null, kind: "web", cited: false });
        }
      }
    }
    if (block.type === "text" && Array.isArray(block.citations)) {
      for (const c of block.citations) {
        if (c.url) sources.push({ label: c.title || c.url, url: c.url, kind: "web", cited: true });
      }
    }
  }
}

function dedupeSources(sources) {
  const byKey = new Map();
  for (const s of sources) {
    const key = s.url || s.label;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, { ...s });
    else {
      prev.cited = prev.cited || s.cited;
      prev.published_at = prev.published_at || s.published_at || null;
      // Keep the most recent retrieval time for the same data source.
      if (s.retrieved_at && (!prev.retrieved_at || s.retrieved_at > prev.retrieved_at)) prev.retrieved_at = s.retrieved_at;
    }
  }
  // Data sources first, then web results the answer actually cited, then
  // other web results that were consulted (capped so the UI stays tidy).
  const all = [...byKey.values()];
  const data = all.filter((s) => s.kind === "data");
  const cited = all.filter((s) => s.kind === "web" && s.cited);
  const other = all.filter((s) => s.kind === "web" && !s.cited);
  return [...data, ...cited, ...other.slice(0, Math.max(0, 3 - cited.length))];
}

// POST /api/chat  { message, context, sport? }
router.post("/", withTier, requireTier("edge_pro"), async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "message is required" });

  // Work on a copy — the tools replace stale sections with fresh ones.
  const context = req.body.context ? JSON.parse(JSON.stringify(req.body.context)) : null;
  const sport = resolveSportSlug(req.body, context);
  const game = context?.game || null;

  const sources = [];
  const refreshed = [];
  const state = { injuries: context?.injuries && !Array.isArray(context.injuries) ? context.injuries : null, scoresAt: null };
  const runTool = makeToolRunner({ sport, game, userRow: req.userRow, sources, refreshed, state });

  try {
    // Failsafe: availability questions never get answered from missing,
    // failed, or stale injury data — refresh BEFORE the model sees it, so
    // even a model that skips the tool can't treat a gap as "healthy".
    if (sport && game && STATUS_QUESTION.test(message) && injuriesNeedRefresh(state.injuries)) {
      try {
        state.injuries = await getMatchupInjuries(sport, game.homeTeam, game.awayTeam, { forceRefresh: true });
        refreshed.push("injuries");
      } catch (err) {
        console.error("chat pre-refresh of injuries failed:", err.message);
      }
    }
    if (context && state.injuries) context.injuries = state.injuries;
    for (const side of ["homeTeam", "awayTeam"]) {
      const r = state.injuries?.[side];
      if (r?.status === "ok") sources.push({ label: `${r.source} injury report — ${r.team}`, url: r.source_url, retrieved_at: r.retrieved_at, kind: "data" });
    }

    const freshness = buildFreshness(context);
    let webSearchOn = WEB_SEARCH_ENABLED;
    const nowIso = new Date().toISOString();

    const messages = [{ role: "user", content: message }];
    let data = null;
    let rounds = 0;
    let usedWebSearch = false;

    while (rounds < MAX_TOOL_ROUNDS) {
      rounds++;
      const body = {
        model: CHAT_MODEL,
        // Covers thinking + tool calls + the reply; see git history for why
        // this can't be small (an empty reply at max_tokens was a real bug).
        max_tokens: 4096,
        system: buildSystemPrompt({ context, freshness, nowIso, webSearchOn }),
        tools: webSearchOn ? [...DATA_TOOLS, webSearchTool()] : DATA_TOOLS,
        messages,
      };
      try {
        data = await callAnthropic(body);
      } catch (err) {
        // Web search not enabled for this org / tool version not supported —
        // degrade to data tools only rather than failing the whole answer.
        if (webSearchOn && err.status === 400 && /web_search|server tool|tool type/i.test(err.body || "")) {
          console.error("Web search unavailable, retrying without it:", err.body?.slice(0, 300));
          webSearchOn = false;
          rounds--;
          continue;
        }
        throw err;
      }

      collectWebSources(data.content, sources);
      if ((data.content || []).some((b) => b.type === "server_tool_use")) usedWebSearch = true;
      messages.push({ role: "assistant", content: data.content });

      if (data.stop_reason === "pause_turn") continue; // long web search — resume as-is
      if (data.stop_reason !== "tool_use") break;

      const toolUses = (data.content || []).filter((b) => b.type === "tool_use");
      const results = await Promise.all(
        toolUses.map(async (tu) => {
          try {
            const out = await runTool(tu.name, tu.input);
            return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) };
          } catch (err) {
            console.error(`chat tool ${tu.name} failed:`, err.message);
            return {
              type: "tool_result",
              tool_use_id: tu.id,
              is_error: true,
              content: JSON.stringify({ status: "unavailable", error: err.message, instruction: "Report this data as currently unavailable. Do not guess." }),
            };
          }
        })
      );
      messages.push({ role: "user", content: results });
    }

    // Only the text after the last search/tool block is the answer — anything
    // before it is the model's "checking the latest reports…" preamble.
    const finalContent = data?.content || [];
    let lastToolIdx = -1;
    finalContent.forEach((b, i) => {
      if (b.type === "server_tool_use" || b.type === "web_search_tool_result" || b.type === "tool_use") lastToolIdx = i;
    });
    const text = finalContent
      .slice(lastToolIdx + 1)
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    if (!text) {
      // Surface as a real error so the frontend's retry path kicks in
      // instead of a silent 200-with-nothing.
      throw new Error(`Empty response from model (stop_reason: ${data?.stop_reason}, rounds: ${rounds})`);
    }

    res.json({
      reply: text,
      sources: dedupeSources(sources),
      refreshed: [...new Set(refreshed)],
      usedWebSearch,
      webSearchAvailable: webSearchOn,
      injuriesRetrievedAt: state.injuries?.retrieved_at || null,
      answeredAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "AI chat failed", detail: err.message });
  }
});

export default router;
