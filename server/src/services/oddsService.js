import { cached, cachedWithMeta, cachedAt, invalidate } from "./cache.js";
import { recordSnapshot } from "./snapshotService.js";
import { recordApiUsage } from "./usageService.js";

const BASE = process.env.ODDS_API_BASE;
const KEY = process.env.ODDS_API_KEY;

// Odds lines don't need to be second-fresh, and each odds call is metered
// against the Odds API's usage credits — so this is cached much longer than
// scores. Override with ODDS_CACHE_TTL_SECONDS if you want a different window.
const ODDS_CACHE_TTL_SECONDS = Number(process.env.ODDS_CACHE_TTL_SECONDS || 1800); // 30 min

// The Odds API returns these on every response, successful or not — capture
// them opportunistically (fire-and-forget) so a usage dashboard can watch
// credit burn without ever making an extra request of its own.
function captureUsageHeaders(res) {
  const num = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  recordApiUsage({
    remaining: num(res.headers.get("x-requests-remaining")),
    used: num(res.headers.get("x-requests-used")),
    last: num(res.headers.get("x-requests-last")),
  }).catch(() => {});
}

// The Odds API sport keys — https://the-odds-api.com/sports-odds-data/sports-apis.html
export const SPORT_KEYS = {
  nfl: "americanfootball_nfl",
  ncaaf: "americanfootball_ncaaf",
  nba: "basketball_nba",
  ncaab: "basketball_ncaab",
  mlb: "baseball_mlb",
};

/**
 * Fetch live odds (moneyline, spread, total) for every upcoming game in a sport.
 * Cached briefly since odds are metered per-request and change frequently.
 */
export async function getOddsForSport(sportSlug) {
  return (await getOddsForSportWithMeta(sportSlug)).value;
}

// When the odds for this sport were last pulled from the provider (null if
// not cached). The Board's "Updated Xm ago" indicator reads this.
export function oddsRetrievedAt(sportSlug) {
  return cachedAt(`odds:${sportSlug}`);
}

// Minimum age before a forced odds refresh is allowed. Every refresh costs an
// Odds API credit, so the AI chat can't burn credits refreshing data that's
// only a minute or two old.
const ODDS_MIN_REFRESH_AGE_SECONDS = Number(process.env.ODDS_MIN_REFRESH_AGE_SECONDS || 300);

// Same as getOddsForSport, plus { retrievedAt }. With forceRefresh, bypasses
// the 30-minute cache — but only when the cached copy is older than
// ODDS_MIN_REFRESH_AGE_SECONDS.
export async function getOddsForSportWithMeta(sportSlug, { forceRefresh = false } = {}) {
  const sportKey = SPORT_KEYS[sportSlug];
  if (!sportKey) throw new Error(`Unknown sport: ${sportSlug}`);

  if (forceRefresh) {
    const at = cachedAt(`odds:${sportSlug}`);
    if (at && (Date.now() - Date.parse(at)) / 1000 > ODDS_MIN_REFRESH_AGE_SECONDS) {
      invalidate(`odds:${sportSlug}`);
    }
  }

  return cachedWithMeta(
    `odds:${sportSlug}`,
    async () => {
      const url = new URL(`${BASE}/sports/${sportKey}/odds`);
      url.searchParams.set("regions", "us");
      url.searchParams.set("markets", "h2h,spreads,totals");
      url.searchParams.set("oddsFormat", "american");
      url.searchParams.set("apiKey", KEY);

      const res = await fetch(url);
      captureUsageHeaders(res);
      if (!res.ok) {
        throw new Error(`Odds API error ${res.status}: ${await res.text()}`);
      }
      const raw = await res.json();
      const games = raw.map(normalizeGame);
      // Fire-and-forget: record this fresh fetch as a line-movement snapshot.
      // Never awaited so a slow/failed DB write can't delay the odds response.
      recordSnapshot(sportSlug, games).catch(() => {});
      return games;
    },
    ODDS_CACHE_TTL_SECONDS
  );
}

/**
 * Fetch recent game results (final scores, and in-progress scores where the
 * provider has them) for a sport. The Odds API's /scores endpoint covers
 * games from up to `daysFrom` days ago through any in-progress ones — this
 * is the same account/key as the odds themselves, so no new provider needed.
 * Cached briefly since live scores change during a game.
 */
export async function getScoresForSport(sportSlug, daysFrom = 3) {
  const sportKey = SPORT_KEYS[sportSlug];
  if (!sportKey) throw new Error(`Unknown sport: ${sportSlug}`);

  return (await getScoresForSportWithMeta(sportSlug, daysFrom)).value;
}

export async function getScoresForSportWithMeta(sportSlug, daysFrom = 3, { forceRefresh = false } = {}) {
  const sportKey = SPORT_KEYS[sportSlug];
  if (!sportKey) throw new Error(`Unknown sport: ${sportSlug}`);
  if (forceRefresh) invalidate(`scores:${sportSlug}:${daysFrom}`);

  return cachedWithMeta(`scores:${sportSlug}:${daysFrom}`, async () => {
    const url = new URL(`${BASE}/sports/${sportKey}/scores`);
    url.searchParams.set("daysFrom", String(daysFrom));
    url.searchParams.set("apiKey", KEY);

    const res = await fetch(url);
    captureUsageHeaders(res);
    if (!res.ok) {
      throw new Error(`Odds API scores error ${res.status}: ${await res.text()}`);
    }
    const raw = await res.json();

    // Index by game id for easy lookup. Keep team names + kickoff time too —
    // not just the score — because a game that has already finished (or even
    // kicked off) is often dropped from the /odds endpoint entirely once
    // sportsbooks stop taking action on it. That's especially common on a
    // busy college football/basketball Saturday with 40+ games — without
    // these fields, games.js has no way to show that game at all once it
    // falls out of /odds, even though we know its final score right here.
    const byId = {};
    for (const g of raw) {
      const scores = g.scores
        ? Object.fromEntries(g.scores.map((s) => [s.name, s.score]))
        : null;
      byId[g.id] = {
        completed: !!g.completed,
        homeScore: scores ? scores[g.home_team] : null,
        awayScore: scores ? scores[g.away_team] : null,
        homeTeam: g.home_team,
        awayTeam: g.away_team,
        commenceTime: g.commence_time,
        // When the provider last touched this game's score — for a completed
        // game this is effectively "when it ended," and is what the Board
        // uses to drop final games off the list after 24 hours. Falls back
        // to commenceTime (set below, after this loop) if the provider ever
        // omits it.
        lastUpdate: g.last_update || null,
      };
    }
    return byId;
  });
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The Board's headline odds (spread/moneyline/total) are a market-consensus
// figure, not any one sportsbook's line: for each side of a market (e.g.
// "Over"/"Under", or a team name), take the MEDIAN point and MEDIAN price
// across every book The Odds API returned for this game. Median (not mean)
// so one outlier book can't skew the number the way an average would.
//
// This never invents a number — a side only appears here if at least one real
// book reported it, and the value returned is always a real reported point or
// price (or, for an even book count, the arithmetic midpoint of two real
// values sitting next to each other in sorted order — still derived only from
// disclosed prices, never fabricated from nothing). Spread/total points are
// rounded to the nearest half-point, matching standard bookmaker granularity;
// moneyline/spread/total prices are rounded to the nearest whole American-odds
// number. If a market has no books reporting at all, it comes back empty,
// exactly as it did before — we don't fill gaps with a guess or another
// book's line.
function consensusMarket(books, marketKey, { roundToHalf = false } = {}) {
  const bySide = {};
  for (const b of books) {
    const market = b.markets?.find((m) => m.key === marketKey);
    for (const o of market?.outcomes || []) {
      if (!bySide[o.name]) bySide[o.name] = { points: [], prices: [] };
      if (o.point !== undefined && o.point !== null) bySide[o.name].points.push(Number(o.point));
      if (o.price !== undefined && o.price !== null) bySide[o.name].prices.push(Number(o.price));
    }
  }
  return Object.entries(bySide).map(([name, v]) => {
    const entry = { name };
    if (v.points.length) {
      const m = median(v.points);
      entry.point = roundToHalf ? Math.round(m * 2) / 2 : m;
    }
    if (v.prices.length) entry.price = Math.round(median(v.prices));
    return entry;
  });
}

/** Reshape the provider's payload into the flat structure the frontend/AI expect. */
function normalizeGame(game) {
  const books = game.bookmakers || [];

  const extractMarket = (book, key) =>
    book?.markets?.find((m) => m.key === key)?.outcomes || [];

  return {
    id: game.id,
    sport: game.sport_key,
    commenceTime: game.commence_time,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    // Internal only — NOT the source of the odds shown above, and not sent to
    // the Board. This just pins the opening-line/line-movement history (see
    // snapshotService.getLineHistory) to one consistent book over time so that
    // comparison is apples-to-apples; the Breakdown screen's "detailed
    // comparison" view is the one place a specific book name is still shown.
    lineTrackingBook: books[0]?.title || null,
    moneyline: consensusMarket(books, "h2h"),
    spread: consensusMarket(books, "spreads", { roundToHalf: true }),
    total: consensusMarket(books, "totals", { roundToHalf: true }),
    consensusBookCount: books.length,
    allBooks: books.map((b) => ({
      book: b.title,
      moneyline: extractMarket(b, "h2h"),
      spread: extractMarket(b, "spreads"),
      total: extractMarket(b, "totals"),
    })),
  };
}
