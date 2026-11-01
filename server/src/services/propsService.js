import { pool, ensureSchema } from "../db.js";
import { SPORT_KEYS, getOddsForSport } from "./oddsService.js";
import { recordApiUsage } from "./usageService.js";
import { impliedProbability } from "./marketMath.js";
import { localDay, currentTz } from "./timeService.js";

// ---------------------------------------------------------------------------
// Props Edge — DraftKings player props for NFL and NBA.
//
// DraftKings has no public API, so props come from The Odds API (the same
// account the Games board already uses). Props are fetched one game at a time
// from /events/{id}/odds, and each prop type costs 1 credit per game. Asking
// for up to 10 bookmakers still costs one "region", so we pull DraftKings plus
// nine other US books for the same price and use them to measure how good
// DraftKings' line and price are (the "edge").
//
// Credits are protected three ways:
//   1. Each game's props are cached (memory + database) for 1–4 hours
//      depending on how close kickoff is, and shared by every user.
//   2. A daily props credit cap (PROPS_DAILY_CREDIT_CAP, Pacific day).
//   3. A floor on the account's remaining credits (PROPS_MIN_REMAINING) so
//      props can never starve the Games board.
// When a limit is hit, the last pull is served with a "paused" note instead.
// ---------------------------------------------------------------------------

const BASE = process.env.ODDS_API_BASE;
const KEY = process.env.ODDS_API_KEY;
const DAILY_CAP = Number(process.env.PROPS_DAILY_CREDIT_CAP || 300);
const MIN_REMAINING = Number(process.env.PROPS_MIN_REMAINING || 3000);
const PT = "America/Los_Angeles";

export const PROPS_SPORTS = ["nfl", "nba"];

// Core markets only — every market costs a credit per game.
export const PROP_MARKETS = {
  nfl: [
    { key: "player_pass_yds", label: "Pass Yds", short: "Pass Yds" },
    { key: "player_pass_tds", label: "Pass TDs", short: "Pass TD" },
    { key: "player_rush_yds", label: "Rush Yds", short: "Rush Yds" },
    { key: "player_reception_yds", label: "Rec Yds", short: "Rec Yds" },
    { key: "player_receptions", label: "Receptions", short: "Rec" },
    { key: "player_anytime_td", label: "Anytime TD", short: "Anytime TD" },
  ],
  nba: [
    { key: "player_points", label: "Points", short: "Pts" },
    { key: "player_rebounds", label: "Rebounds", short: "Reb" },
    { key: "player_assists", label: "Assists", short: "Ast" },
    { key: "player_threes", label: "3-Pointers", short: "3PM" },
    { key: "player_points_rebounds_assists", label: "Pts+Reb+Ast", short: "PRA" },
  ],
};

// Up to 10 bookmakers = 1 region of credit cost. DraftKings first.
export const PROPS_BOOKS = [
  "draftkings", "fanduel", "betmgm", "williamhill_us", "fanatics",
  "betrivers", "espnbet", "hardrockbet", "bovada", "betonlineag",
];

// ---- Math ------------------------------------------------------------------

const pct = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 10);

// Profit per $1 staked at American odds.
export function payout(price) {
  const p = Number(price);
  if (!Number.isFinite(p) || Math.abs(p) < 100) return null;
  return p > 0 ? p / 100 : 100 / -p;
}

// Expected value (% of stake) of a bet at `price` when the true chance is `prob`.
export function expectedValue(prob, price) {
  const b = payout(price);
  if (b == null || prob == null) return null;
  return pct(prob * b - (1 - prob));
}

function median(nums) {
  const a = nums.filter(Number.isFinite).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// ---- Normalize --------------------------------------------------------------

/**
 * Raw /events/{id}/odds response -> DraftKings-centric props with edge math.
 * Only players DraftKings actually offers are kept.
 */
export function normalizeProps(raw, sport) {
  const markets = PROP_MARKETS[sport] || [];
  const labelOf = Object.fromEntries(markets.map((m) => [m.key, m]));
  const books = raw?.bookmakers || [];
  const dk = books.find((b) => b.key === "draftkings");
  const others = books.filter((b) => b.key !== "draftkings");
  const props = [];

  for (const mk of dk?.markets || []) {
    const meta = labelOf[mk.key];
    if (!meta) continue;
    const byPlayer = new Map();
    for (const o of mk.outcomes || []) {
      const player = o.description || null;
      if (!player) continue;
      if (!byPlayer.has(player)) byPlayer.set(player, []);
      byPlayer.get(player).push(o);
    }
    for (const [player, outs] of byPlayer) {
      const over = outs.find((o) => o.name === "Over");
      const under = outs.find((o) => o.name === "Under");
      const yes = outs.find((o) => o.name === "Yes");

      // The same player + market at every other book.
      const peers = [];
      for (const b of others) {
        const m = b.markets?.find((x) => x.key === mk.key);
        if (!m) continue;
        const po = (m.outcomes || []).filter((o) => o.description === player);
        if (po.length) peers.push({ book: b.title, outs: po });
      }

      if (over || under) {
        const line = Number(over?.point ?? under?.point);
        const peerLines = peers.map((p) => Number((p.outs.find((o) => o.name === "Over") || p.outs[0])?.point));
        // No-vig fair probability from every other book posting the SAME line
        // with both sides, averaged.
        const fairs = [];
        for (const p of peers) {
          const po = p.outs.find((o) => o.name === "Over" && Number(o.point) === line);
          const pu = p.outs.find((o) => o.name === "Under" && Number(o.point) === line);
          const io = impliedProbability(po?.price);
          const iu = impliedProbability(pu?.price);
          if (io != null && iu != null) fairs.push(io / (io + iu));
        }
        const fairOver = fairs.length ? fairs.reduce((s, x) => s + x, 0) / fairs.length : null;
        const evOver = over && fairOver != null ? expectedValue(fairOver, over.price) : null;
        const evUnder = under && fairOver != null ? expectedValue(1 - fairOver, under.price) : null;
        const consensusLine = median(peerLines);
        let best = null;
        if (evOver != null || evUnder != null) {
          best = (evOver ?? -Infinity) >= (evUnder ?? -Infinity) ? { side: "Over", ev: evOver } : { side: "Under", ev: evUnder };
        }
        props.push({
          id: `${mk.key}|${player}`,
          player,
          market: mk.key,
          marketLabel: meta.label,
          kind: "ou",
          line: Number.isFinite(line) ? line : null,
          over: over ? over.price : null,
          under: under ? under.price : null,
          dkImplied: { over: pct(impliedProbability(over?.price)), under: pct(impliedProbability(under?.price)) },
          fair: fairOver != null ? { over: pct(fairOver), under: pct(1 - fairOver) } : null,
          ev: { over: evOver, under: evUnder },
          best,
          consensusLine,
          // Positive = DraftKings' line is lower than the market (better for Over).
          lineGap: consensusLine != null && Number.isFinite(line) ? Math.round((consensusLine - line) * 10) / 10 : null,
          booksCompared: peers.length,
          fairBooks: fairs.length,
        });
      } else if (yes) {
        // Yes-only markets (Anytime TD): no Under side, so no clean no-vig
        // price. Compare DraftKings' price to the other books' average.
        const peerProbs = peers.map((p) => impliedProbability((p.outs.find((o) => o.name === "Yes") || {}).price)).filter((x) => x != null);
        const avg = peerProbs.length ? peerProbs.reduce((s, x) => s + x, 0) / peerProbs.length : null;
        const dkProb = impliedProbability(yes.price);
        props.push({
          id: `${mk.key}|${player}`,
          player,
          market: mk.key,
          marketLabel: meta.label,
          kind: "yes",
          line: null,
          yes: yes.price,
          dkImplied: { yes: pct(dkProb) },
          marketAvgImplied: pct(avg),
          // Positive = DraftKings pays more than the other books on average.
          priceGap: avg != null && dkProb != null ? pct(avg - dkProb) : null,
          best: null,
          booksCompared: peers.length,
        });
      }
    }
  }

  props.sort((a, b) => (b.best?.ev ?? -99) - (a.best?.ev ?? -99) || a.player.localeCompare(b.player));
  return {
    eventId: raw?.id || null,
    sport,
    homeTeam: raw?.home_team || null,
    awayTeam: raw?.away_team || null,
    commenceTime: raw?.commence_time || null,
    hasDraftKings: !!dk,
    dkLastUpdate: dk?.last_update || null,
    booksCompared: others.map((b) => b.title),
    markets: markets.map((m) => ({ key: m.key, label: m.label, count: props.filter((p) => p.market === m.key).length })),
    props,
  };
}

// ---- Budget ------------------------------------------------------------------

let lastRemaining = null; // from the most recent Odds API response we saw
const memSpend = { day: null, credits: 0 }; // fallback when there's no database

function ptDay(d = new Date()) {
  return localDay(d.toISOString(), PT);
}

async function creditsSpentToday() {
  if (pool) {
    try {
      await ensureSchema();
      const { rows } = await pool.query(
        `SELECT COALESCE(SUM(credits),0)::int AS n FROM props_credit_log
          WHERE created_at >= (date_trunc('day', now() AT TIME ZONE '${PT}') AT TIME ZONE '${PT}')`
      );
      return rows[0].n;
    } catch (err) {
      console.error("[props] credit log read failed:", err.message);
    }
  }
  return memSpend.day === ptDay() ? memSpend.credits : 0;
}

async function logCredits(eventId, credits) {
  const today = ptDay();
  if (memSpend.day !== today) Object.assign(memSpend, { day: today, credits: 0 });
  memSpend.credits += credits;
  if (!pool) return;
  try {
    await pool.query("INSERT INTO props_credit_log (event_id, credits) VALUES ($1, $2)", [eventId, credits]);
  } catch (err) {
    console.error("[props] credit log write failed:", err.message);
  }
}

async function latestRemaining() {
  if (lastRemaining != null) return lastRemaining;
  if (!pool) return null;
  try {
    await ensureSchema();
    const { rows } = await pool.query("SELECT requests_remaining FROM odds_api_usage WHERE requests_remaining IS NOT NULL ORDER BY recorded_at DESC LIMIT 1");
    return rows[0]?.requests_remaining ?? null;
  } catch {
    return null;
  }
}

/** Why a new props pull isn't allowed right now, or null if it is. */
export async function budgetBlock(sport) {
  const spent = await creditsSpentToday();
  const cost = PROP_MARKETS[sport]?.length || 6;
  if (spent + cost > DAILY_CAP) return `Today's props data budget is used up (${spent} of ${DAILY_CAP} credits). Showing the last pull; fresh lines resume after midnight Pacific.`;
  const rem = await latestRemaining();
  if (rem != null && rem - cost < MIN_REMAINING) return `The odds data plan is running low (${rem} credits left), so props refreshes are paused to keep the Games board running.`;
  return null;
}

export async function budgetStatus() {
  return { dailyCap: DAILY_CAP, spentToday: await creditsSpentToday(), minRemaining: MIN_REMAINING, accountRemaining: await latestRemaining() };
}

// ---- Storage + fetch -----------------------------------------------------------

const mem = new Map(); // eventId -> { data, fetchedAt }
const inflight = new Map();

// Props get stale faster as kickoff nears.
export function freshForSeconds(commenceTime, now = Date.now()) {
  const hrs = (Date.parse(commenceTime) - now) / 3.6e6;
  if (!Number.isFinite(hrs)) return 2 * 3600;
  if (hrs > 8) return 4 * 3600;
  if (hrs > 2) return 2 * 3600;
  return 3600;
}

async function loadSnapshot(eventId) {
  if (mem.has(eventId)) return mem.get(eventId);
  if (!pool) return null;
  try {
    await ensureSchema();
    const { rows } = await pool.query("SELECT data, fetched_at FROM props_snapshots WHERE event_id = $1", [eventId]);
    if (!rows.length) return null;
    const snap = { data: rows[0].data, fetchedAt: new Date(rows[0].fetched_at).toISOString() };
    mem.set(eventId, snap);
    return snap;
  } catch (err) {
    console.error("[props] snapshot read failed:", err.message);
    return null;
  }
}

async function saveSnapshot(eventId, sport, snap) {
  mem.set(eventId, snap);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO props_snapshots (event_id, sport, data, fetched_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id) DO UPDATE SET data = EXCLUDED.data, fetched_at = EXCLUDED.fetched_at`,
      [eventId, sport, JSON.stringify(snap.data), snap.fetchedAt]
    );
  } catch (err) {
    console.error("[props] snapshot write failed:", err.message);
  }
}

// Swappable for tests.
let fetchImpl = (...a) => fetch(...a);
export function __setFetch(fn) { fetchImpl = fn; }
export function __reset() { mem.clear(); inflight.clear(); lastRemaining = null; Object.assign(memSpend, { day: null, credits: 0 }); }

async function fetchFromProvider(sport, eventId) {
  const markets = PROP_MARKETS[sport].map((m) => m.key);
  const url = new URL(`${BASE}/sports/${SPORT_KEYS[sport]}/events/${encodeURIComponent(eventId)}/odds`);
  url.searchParams.set("bookmakers", PROPS_BOOKS.join(","));
  url.searchParams.set("markets", markets.join(","));
  url.searchParams.set("oddsFormat", "american");
  url.searchParams.set("apiKey", KEY);
  const res = await fetchImpl(url);
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  const remaining = num(res.headers?.get?.("x-requests-remaining"));
  const last = num(res.headers?.get?.("x-requests-last"));
  if (remaining != null) lastRemaining = remaining;
  recordApiUsage({ remaining, used: num(res.headers?.get?.("x-requests-used")), last }).catch(() => {});
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(res.status === 404 ? "This game isn't available from the odds provider any more." : `Odds API props error ${res.status}: ${text.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const raw = await res.json();
  const data = normalizeProps(raw, sport);
  const credits = last ?? data.markets.filter((m) => m.count > 0).length;
  if (credits > 0) await logCredits(eventId, credits);
  return data;
}

/**
 * Props for one game: { data, fetchedAt, fromCache, stale, paused, pausedReason }.
 * Never refetches after kickoff (pregame lines are what Props Edge compares).
 */
export async function getGameProps(sport, eventId, { commenceTime, onlyCached = false } = {}) {
  if (!PROPS_SPORTS.includes(sport)) throw Object.assign(new Error(`Props aren't available for ${sport}.`), { status: 400 });
  const snap = await loadSnapshot(eventId);
  if (onlyCached) {
    return snap ? { ...snap, fromCache: true, stale: false, started: Date.parse(snap.data?.commenceTime) <= Date.now() } : null;
  }
  const kickoff = commenceTime || snap?.data?.commenceTime;
  const started = kickoff ? Date.parse(kickoff) <= Date.now() : false;
  const ageSec = snap ? (Date.now() - Date.parse(snap.fetchedAt)) / 1000 : Infinity;
  const fresh = snap && ageSec < freshForSeconds(kickoff || snap.data?.commenceTime);

  if (snap && (fresh || started)) return { ...snap, fromCache: true, stale: false, started };
  if (!snap && started) {
    return { data: null, fetchedAt: null, fromCache: false, stale: false, started, paused: true, pausedReason: "This game has started. Props Edge shows pregame lines, and none were pulled for this game before kickoff." };
  }

  const block = await budgetBlock(sport);
  if (block) {
    if (snap) return { ...snap, fromCache: true, stale: true, paused: true, pausedReason: block, started };
    return { data: null, fetchedAt: null, fromCache: false, stale: false, paused: true, pausedReason: block, started };
  }

  if (!inflight.has(eventId)) {
    inflight.set(eventId, (async () => {
      try {
        const data = await fetchFromProvider(sport, eventId);
        const fresh = { data, fetchedAt: new Date().toISOString() };
        await saveSnapshot(eventId, sport, fresh);
        return fresh;
      } finally {
        inflight.delete(eventId);
      }
    })());
  }
  try {
    const got = await inflight.get(eventId);
    return { ...got, fromCache: false, stale: false, started };
  } catch (err) {
    if (snap) {
      console.error(`[props] refresh failed for ${eventId}, serving last pull:`, err.message);
      return { ...snap, fromCache: true, stale: true, started, pausedReason: "Couldn't refresh props just now; showing the last pull." };
    }
    throw err;
  }
}

/**
 * Today's (or tomorrow's) games for a sport in the user's time zone, from the
 * Games board's cached odds (no extra credits). Each game says whether props
 * are already loaded.
 */
export async function getSlate(sport, { day = "today", tz = currentTz(), now = Date.now() } = {}) {
  if (!PROPS_SPORTS.includes(sport)) throw Object.assign(new Error(`Props aren't available for ${sport}.`), { status: 400 });
  const target = localDay(new Date(now + (day === "tomorrow" ? 86400000 : 0)).toISOString(), tz);
  const games = (await getOddsForSport(sport)) || [];
  const todays = games
    .filter((g) => g.commenceTime && localDay(g.commenceTime, tz) === target)
    .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));
  const out = [];
  for (const g of todays) {
    const snap = await loadSnapshot(g.id);
    out.push({
      id: g.id,
      sport,
      homeTeam: g.homeTeam,
      awayTeam: g.awayTeam,
      commenceTime: g.commenceTime,
      started: Date.parse(g.commenceTime) <= now,
      spread: g.spread || null,
      total: g.total || null,
      propsFetchedAt: snap?.fetchedAt || null,
      propsCount: snap?.data?.props?.length ?? null,
    });
  }
  return { sport, day, date: target, games: out };
}
