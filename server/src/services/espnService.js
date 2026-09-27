import NodeCache from "node-cache";
import { toEspnCode } from "../data/espnTeamCodes.js";

// ESPN's public site API — no API key required. Unofficial but widely used and
// stable; used here specifically to fill in FINAL SCORES for past meetings,
// since our paid stats provider's trial tier doesn't include them.
//
// Each sport has its own URL path on ESPN's site.
const ESPN_SPORT_PATHS = {
  nfl: "football/nfl",
  nba: "basketball/nba",
  mlb: "baseball/mlb",
};

// A separate, long-lived cache from the app's general 90-second odds cache.
// A completed game's final score never changes, so once we've successfully
// fetched a season's schedule there's no reason to keep re-fetching it — and
// critically, keeping a *successful* result cached means a later transient
// ESPN failure (a timeout, a temporary block, a hiccup) doesn't wipe out data
// we already had. We only ever overwrite an entry on a new successful fetch.
const scheduleCache = new NodeCache({ checkperiod: 3600 });

async function espnGet(sportSlug, path) {
  const sportPath = ESPN_SPORT_PATHS[sportSlug];
  if (!sportPath) throw new Error(`ESPN integration not set up for sport: ${sportSlug}`);

  const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}${path}`;
  // ESPN's public API blocks plain server-side requests without browser-like
  // headers — this makes the request look like it's coming from a real browser.
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`ESPN API error ${res.status}`);
  }
  return res.json();
}

// Retries a transient failure once (with a short delay) before giving up, so
// a single dropped request doesn't take down a whole lookup.
async function withRetry(fn, attempts = 2, delayMs = 800) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function getTeamSchedule(sportSlug, teamCode, season) {
  const key = `espn-schedule:${sportSlug}:${teamCode}:${season}`;
  const hit = scheduleCache.get(key);
  if (hit !== undefined) return hit;

  const data = await withRetry(() =>
    espnGet(sportSlug, `/teams/${teamCode}/schedule?season=${season}&seasontype=2`)
  );

  // A fully-completed past season never changes — cache it forever (ttl 0 =
  // no expiry). The current season is still in progress, so cache it for a
  // day: long enough to avoid hammering ESPN on every request, short enough
  // that newly-completed games show up without a redeploy.
  const currentYear = new Date().getFullYear();
  const ttlSeconds = Number(season) < currentYear ? 0 : 24 * 60 * 60;
  scheduleCache.set(key, data, ttlSeconds);
  return data;
}

// Returns past meetings between two teams (by full name) with final scores,
// looking back across the current season plus the previous 3. Works for any
// sport listed in ESPN_SPORT_PATHS above.
export async function getHeadToHeadResults(sportSlug, homeFullName, awayFullName, season) {
  if (!ESPN_SPORT_PATHS[sportSlug]) return [];

  const teamCode = toEspnCode(sportSlug, homeFullName);
  const oppCode = toEspnCode(sportSlug, awayFullName);
  if (!teamCode || !oppCode) return [];

  const baseYear = parseInt(season, 10);
  const seasonsToCheck = [baseYear, baseYear - 1, baseYear - 2, baseYear - 3];

  const schedules = await Promise.all(
    seasonsToCheck.map((y) => getTeamSchedule(sportSlug, teamCode, y).catch(() => null))
  );

  const results = [];
  for (const schedule of schedules) {
    const events = schedule?.events || [];
    for (const event of events) {
      const competition = event.competitions?.[0];
      if (!competition) continue;
      const competitors = competition.competitors || [];
      const opponent = competitors.find((c) => c.team?.abbreviation === oppCode);
      if (!opponent) continue;
      // Only include games that have actually been played.
      if (competition.status?.type?.state !== "post") continue;

      const home = competitors.find((c) => c.homeAway === "home");
      const away = competitors.find((c) => c.homeAway === "away");
      if (!home || !away) continue;

      results.push({
        date: event.date,
        season: event.season?.year,
        homeTeam: home.team?.displayName,
        awayTeam: away.team?.displayName,
        homeScore: home.score?.value ?? home.score,
        awayScore: away.score?.value ?? away.score,
        winner: home.winner ? home.team?.displayName : away.winner ? away.team?.displayName : "Tie",
      });
    }
  }

  results.sort((a, b) => new Date(b.date) - new Date(a.date));
  return results;
}
