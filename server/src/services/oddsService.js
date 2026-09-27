import { cached } from "./cache.js";
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
  const sportKey = SPORT_KEYS[sportSlug];
  if (!sportKey) throw new Error(`Unknown sport: ${sportSlug}`);

  return cached(
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

  return cached(`scores:${sportSlug}:${daysFrom}`, async () => {
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

/** Reshape the provider's payload into the flat structure the frontend/AI expect. */
function normalizeGame(game) {
  const books = game.bookmakers || [];
  // Use the first book with full market coverage as the "primary" display line;
  // keep all books so the frontend can offer line-shopping later.
  const primary = books[0];

  const extractMarket = (book, key) =>
    book?.markets?.find((m) => m.key === key)?.outcomes || [];

  return {
    id: game.id,
    sport: game.sport_key,
    commenceTime: game.commence_time,
    homeTeam: game.home_team,
    awayTeam: game.away_team,
    primaryBook: primary?.title || null,
    moneyline: extractMarket(primary, "h2h"),
    spread: extractMarket(primary, "spreads"),
    total: extractMarket(primary, "totals"),
    allBooks: books.map((b) => ({
      book: b.title,
      moneyline: extractMarket(b, "h2h"),
      spread: extractMarket(b, "spreads"),
      total: extractMarket(b, "totals"),
    })),
  };
}
