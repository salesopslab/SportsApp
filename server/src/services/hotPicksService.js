import { pool } from "../db.js";
import { getOddsForSport } from "./oddsService.js";
import { getInjuries } from "./statsService.js";

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Internal sport slugs used by oddsService/statsService (see oddsService.js's
// SPORT_KEY map and statsService.js's SDIO_SPORT_SEGMENT) -- "ncaaf"/"ncaab",
// not the "ncaafb"/"ncaamb" display codes used elsewhere in the frontend.
const SPORTS = ["nfl", "nba", "mlb", "ncaaf", "ncaab"];

// A game only enters the day's bundle once it's within 24 hours of kickoff —
// this is the actual product promise ("available 24 hours prior to game
// start"), and it also keeps the picks fresh: nothing sold days in advance
// that a line (or an injury report) can drift away from before it matters.
const WINDOW_MS = 24 * 60 * 60 * 1000;

// Caps how many games go into the model's context — keeps the prompt (and
// the bill) bounded on a huge slate (a full NCAAF Saturday is 60+ games)
// without needing every single game to pick a handful of the best ones.
const MAX_CANDIDATE_GAMES = 30;

const PICKS_PER_DAY = 4;

function round2(n) {
  return Math.round(n * 100) / 100;
}

async function buildSlate() {
  const now = Date.now();
  const bySport = await Promise.all(
    SPORTS.map(async (sport) => {
      const [games, injuries] = await Promise.all([
        getOddsForSport(sport).catch(() => []),
        getInjuries(sport).catch(() => []),
      ]);
      const upcoming = (games || []).filter((g) => {
        const c = new Date(g.commenceTime).getTime();
        return c > now && c - now <= WINDOW_MS && (g.moneyline?.length || g.spread?.length || g.total?.length);
      });
      return { sport, games: upcoming, injuries: injuries || [] };
    })
  );
  return bySport;
}

function summarizeGameForPrompt(sport, g) {
  return {
    sport,
    gameId: g.id,
    commenceTime: g.commenceTime,
    homeTeam: g.homeTeam,
    awayTeam: g.awayTeam,
    moneyline: g.moneyline || [],
    spread: g.spread || [],
    total: g.total || [],
  };
}

// Calls the same Claude setup as chat.js/bets.js -- reviews the slate of
// games kicking off in the next 24 hours and picks the strongest handful,
// each with a written blurb. This is the "confidence score" selection: an
// LLM read of the market/injury picture rather than a hand-built formula.
export async function generateHotPicksForToday() {
  const bySport = await buildSlate();
  const candidates = [];
  for (const { sport, games } of bySport) {
    for (const g of games) candidates.push(summarizeGameForPrompt(sport, g));
  }
  candidates.sort((a, b) => new Date(a.commenceTime) - new Date(b.commenceTime));
  const trimmed = candidates.slice(0, MAX_CANDIDATE_GAMES);
  if (!trimmed.length) return { picks: [] };

  const injuriesBySport = Object.fromEntries(bySport.map((b) => [b.sport, b.injuries]));

  const systemPrompt = `You are BetEdge AI's Hot Picks selector. You review a slate of games kicking off in the next 24 hours and select the ${PICKS_PER_DAY} strongest, highest-conviction picks to sell as a paid daily bundle to Edge Pro subscribers.

## Grounding rules (non-negotiable)
1. Use ONLY facts present in CANDIDATE_GAMES and INJURIES_BY_SPORT below. Do not invent injuries, records, or narratives not present in this data.
2. Select ONLY from the games listed in CANDIDATE_GAMES, using their exact gameId.
3. For each pick, choose exactly one market ("moneyline", "spread", or "total") and one side that is actually priced in that game's data (a real team name for moneyline/spread, or "Over"/"Under" for total), and copy its price (American odds) and point (if any) exactly as given.
4. Pick fewer than ${PICKS_PER_DAY} if the slate genuinely doesn't have that many picks you'd stand behind -- never pad with weak picks to hit a count.
5. Never guarantee an outcome. This is a paid product, so it must hold up: back every pick with a specific, checkable reason (a market signal or a listed injury), not vibes or "trust the model."

## Output format
Return ONLY valid JSON, no prose, no markdown fences, matching exactly:
{
  "picks": [
    {
      "gameId": string,        // must exactly match a CANDIDATE_GAMES gameId
      "market": "moneyline" | "spread" | "total",
      "side": string,          // exact team name, or "Over"/"Under"
      "point": number | null,  // the spread/total number if applicable, else null
      "price": number,         // American odds, copied from the game's own data
      "confidence": "medium" | "high" | "very_high",
      "analysis": string       // 2-4 sentences: the specific, checkable reasoning for this pick
    }
  ]
}`;

  const userMessage = `CANDIDATE_GAMES:\n${JSON.stringify(trimmed)}\n\nINJURIES_BY_SPORT:\n${JSON.stringify(injuriesBySport)}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5",
      // See chat.js for why this is sized generously -- max_tokens caps
      // thinking + text together, and a stingy budget can be entirely
      // consumed by thinking with zero text written out.
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
  }

  const data = await response.json();
  const text = data.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  if (!text) {
    throw new Error(`Empty response from model (stop_reason: ${data.stop_reason})`);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model did not return JSON.");
    parsed = JSON.parse(match[0]);
  }

  const byId = Object.fromEntries(trimmed.map((c) => [c.gameId, c]));
  const rawPicks = Array.isArray(parsed.picks) ? parsed.picks : [];
  const picks = rawPicks
    .filter(
      (p) =>
        byId[p.gameId] &&
        ["moneyline", "spread", "total"].includes(p.market) &&
        p.side &&
        Number.isFinite(Number(p.price)) &&
        p.analysis
    )
    .slice(0, PICKS_PER_DAY)
    .map((p) => ({ ...p, game: byId[p.gameId] }));

  return { picks };
}

// Returns today's hot_pick_days row, generating and persisting it (plus its
// hot_picks rows) on the first call of the day. Cached in the DB after that
// -- this app has no cron/scheduler, so "lazy generate on first request,
// then reuse" is the same pattern db.js's own ensureSchema() uses.
export async function getOrCreateTodaysHotPickDay({ priceCents = 5000, maxPurchasers = 50 } = {}) {
  if (!pool) return null;
  const today = new Date().toISOString().slice(0, 10);

  const existing = await pool.query("SELECT * FROM hot_pick_days WHERE bet_date = $1", [today]);
  if (existing.rows.length) return existing.rows[0];

  const { picks } = await generateHotPicksForToday();

  const inserted = await pool.query(
    `INSERT INTO hot_pick_days (bet_date, price_cents, max_purchasers) VALUES ($1, $2, $3) RETURNING *`,
    [today, priceCents, maxPurchasers]
  );
  const day = inserted.rows[0];

  for (const p of picks) {
    await pool.query(
      `INSERT INTO hot_picks (hot_pick_day_id, sport, game_id, home_team, away_team, market, side, point, price, confidence, analysis, commence_time)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        day.id,
        p.game.sport,
        p.gameId,
        p.game.homeTeam,
        p.game.awayTeam,
        p.market,
        p.side,
        p.point != null ? round2(Number(p.point)) : null,
        Math.round(Number(p.price)),
        p.confidence || "medium",
        p.analysis,
        p.game.commenceTime,
      ]
    );
  }

  return day;
}

export async function loadHotPickDayWithPicks(dayId) {
  const [dayRows, pickRows] = await Promise.all([
    pool.query("SELECT * FROM hot_pick_days WHERE id = $1", [dayId]),
    pool.query("SELECT * FROM hot_picks WHERE hot_pick_day_id = $1 ORDER BY commence_time ASC", [dayId]),
  ]);
  return { day: dayRows.rows[0] || null, picks: pickRows.rows };
}
