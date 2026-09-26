import { cached } from "./cache.js";

const KEY = process.env.SPORTSDATA_API_KEY;

const SPORT_BASE = {
  nfl: process.env.SPORTSDATA_NFL_BASE,
  ncaaf: process.env.SPORTSDATA_CFB_BASE,
  nba: process.env.SPORTSDATA_NBA_BASE,
  ncaab: process.env.SPORTSDATA_CBB_BASE,
  mlb: process.env.SPORTSDATA_MLB_BASE,
};

async function get(base, path) {
  const url = `${base}${path}${path.includes("?") ? "&" : "?"}key=${KEY}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`SportsDataIO error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

/** Current-week injury report for a sport. SportsDataIO exposes this per-week for most sports. */
export async function getInjuries(sportSlug, season, week) {
  const base = SPORT_BASE[sportSlug];
  return cached(`injuries:${sportSlug}:${season}:${week}`, () =>
    get(base, `/scores/json/InjuriesByWeek/${season}/${week}`)
  );
}

/** Season-to-date team stats, used for form and matchup context. */
export async function getTeamSeasonStats(sportSlug, season) {
  const base = SPORT_BASE[sportSlug];
  return cached(`teamstats:${sportSlug}:${season}`, () =>
    get(base, `/scores/json/TeamSeasonStats/${season}`)
  );
}

/**
 * Head-to-head history between two teams.
 * SportsDataIO doesn't expose a single "H2H" endpoint, so this pulls each team's
 * schedule and filters for meetings — cached aggressively since history doesn't change mid-season.
 */
export async function getHeadToHead(sportSlug, season, team) {
  const base = SPORT_BASE[sportSlug];
  return cached(`schedule:${sportSlug}:${season}:${team}`, () =>
    get(base, `/scores/json/TeamSchedule/${season}/${team}`)
  );
}
