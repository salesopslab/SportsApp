import { cached } from "./cache.js";
import { toEspnCode } from "../data/espnTeamCodes.js";

// ESPN's public site API — no API key required. Unofficial but widely used and
// stable; used here specifically to fill in FINAL SCORES for past meetings,
// since our paid stats provider's trial tier doesn't include them.
async function espnGet(path) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`ESPN API error ${res.status}`);
  }
  return res.json();
}

async function getTeamSchedule(teamCode, season) {
  return cached(`espn-schedule:${teamCode}:${season}`, () =>
    espnGet(`/teams/${teamCode}/schedule?season=${season}&seasontype=2`)
  );
}

// Returns past meetings between two NFL teams (by full name) with final scores,
// looking back across the current season plus the previous 3.
export async function getHeadToHeadResults(homeFullName, awayFullName, season) {
  const teamCode = toEspnCode(homeFullName);
  const oppCode = toEspnCode(awayFullName);
  if (!teamCode || !oppCode) return [];

  const baseYear = parseInt(season, 10);
  const seasonsToCheck = [baseYear, baseYear - 1, baseYear - 2, baseYear - 3];

  const schedules = await Promise.all(
    seasonsToCheck.map((y) => getTeamSchedule(teamCode, y).catch(() => null))
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
