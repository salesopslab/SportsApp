import { cached } from "./cache.js";

const KEY = process.env.SPORTSDATA_API_KEY;

async function sdioGet(sportSlug, path) {
  const url = `https://api.sportsdata.io/v3/${sportSlug}/${path}`;
  const res = await fetch(url, {
    headers: { "Ocp-Apim-Subscription-Key": KEY },
  });
  if (!res.ok) {
    throw new Error(`SportsDataIO error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export async function getInjuries(sportSlug) {
  return cached(`injuries:${sportSlug}`, () => {
    const isCollege = sportSlug === "ncaaf" || sportSlug === "ncaab";
    const path = isCollege ? "scores/json/InjuredPlayers" : "projections/json/InjuredPlayers";
    return sdioGet(sportSlug, path);
  });
}

export async function getTeamSeasonStats(sportSlug, season) {
  return cached(`teamstats:${sportSlug}:${season}`, () =>
    sdioGet(sportSlug, `scores/json/TeamSeasonStats/${season}`)
  );
}

export async function getSeasonSchedule(sportSlug, season) {
  return cached(`schedule:${sportSlug}:${season}`, () =>
    sdioGet(sportSlug, `scores/json/Schedules/${season}`)
  );
}

// Looks back across the current season plus the previous 3 seasons so real past
// meetings show up, not just this season's (possibly still-upcoming) matchup.
export async function getHeadToHead(sportSlug, season, teamA, teamB) {
  const baseYear = parseInt(season, 10);
  const seasonsToCheck = [baseYear, baseYear - 1, baseYear - 2, baseYear - 3].map(String);

  const schedules = await Promise.all(
    seasonsToCheck.map((s) => getSeasonSchedule(sportSlug, s).catch(() => []))
  );

  const allGames = schedules.flat();
  const matches = allGames.filter(
    (g) =>
      (g.HomeTeam === teamA && g.AwayTeam === teamB) ||
      (g.HomeTeam === teamB && g.AwayTeam === teamA)
  );

  // Most recent meeting first.
  matches.sort((a, b) => new Date(b.DateTime || b.Date || 0) - new Date(a.DateTime || a.Date || 0));

  return matches;
}
