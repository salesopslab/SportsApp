import { cached } from "./cache.js";

const BASE = process.env.ODDS_API_BASE;
const KEY = process.env.ODDS_API_KEY;

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

  return cached(`odds:${sportSlug}`, async () => {
    const url = new URL(`${BASE}/sports/${sportKey}/odds`);
    url.searchParams.set("regions", "us");
    url.searchParams.set("markets", "h2h,spreads,totals");
    url.searchParams.set("oddsFormat", "american");
    url.searchParams.set("apiKey", KEY);

    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`Odds API error ${res.status}: ${await res.text()}`);
    }
    const raw = await res.json();
    return raw.map(normalizeGame);
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
