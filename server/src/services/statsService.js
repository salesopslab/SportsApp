import { cached } from "./cache.js";
import { toTeamCode } from "../data/teamCodes.js";

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

// ---------------------------------------------------------------------------
// Team rankings for the Board: division/conference standing for the pro
// leagues, AP (or nearest available) poll rank for the college sports.
// Every function here is defensive by design — a schema surprise, a missing
// week's poll, or an outright API failure all resolve to an empty map rather
// than throwing, so a rankings hiccup never takes the Board down with it.
// ---------------------------------------------------------------------------

function ordinal(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return String(n);
  const mod100 = num % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${num}th`;
  switch (num % 10) {
    case 1: return `${num}st`;
    case 2: return `${num}nd`;
    case 3: return `${num}rd`;
    default: return `${num}th`;
  }
}

function normalizeSchoolName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();
}

// NFL/NBA/MLB: division standing (e.g. "1st AFC East"), keyed by the same
// team abbreviation used elsewhere in this app (toTeamCode / injury matching).
async function getStandingsRankings(sportSlug, season) {
  return cached(
    `standings-rank:${sportSlug}:${season}`,
    async () => {
      try {
        const rows = await sdioGet(sportSlug, `scores/json/Standings/${season}`);
        const map = {};
        for (const r of rows || []) {
          const code = r.Team || r.Key || r.Abbreviation;
          const rank = r.DivisionRank ?? r.ConferenceRank ?? null;
          if (!code || rank === null || rank === undefined) continue;
          const group = r.Division || r.Conference || "";
          map[code] = {
            rank,
            label: group ? `${ordinal(rank)} ${group}` : ordinal(rank),
            division: r.Division || null,
          };
        }
        return map;
      } catch (err) {
        console.error(`getStandingsRankings(${sportSlug}) failed:`, err.message);
        return {};
      }
    },
    6 * 60 * 60 // standings move slowly — 6h cache is plenty fresh
  );
}

// CFB/CBB: current AP (or nearest named) poll, keyed by a normalized school
// name for best-effort matching against whatever team-name spelling the odds
// feed uses (college team naming isn't as standardized as the pro leagues).
async function getPollRankings(sportSlug, season) {
  return cached(
    `poll-rank:${sportSlug}:${season}`,
    async () => {
      try {
        let week = null;
        if (sportSlug === "ncaaf") {
          week = await sdioGet(sportSlug, "scores/json/CurrentWeek").catch(() => null);
        }
        const path = week ? `scores/json/Rankings/${season}/${week}` : `scores/json/Rankings/${season}`;
        const polls = await sdioGet(sportSlug, path);
        if (!Array.isArray(polls) || !polls.length) return {};
        const apPoll = polls.find((p) => /ap/i.test(p.Name || p.PollName || "")) || polls[0];
        const entries = apPoll.Rankings || apPoll.TeamRankings || [];
        const map = {};
        for (const e of entries) {
          const rank = e.Rank ?? e.CurrentRank;
          const name = e.School || e.Name || e.Team;
          if (!rank || !name) continue;
          map[normalizeSchoolName(name)] = rank;
        }
        return map;
      } catch (err) {
        console.error(`getPollRankings(${sportSlug}) failed:`, err.message);
        return {};
      }
    },
    6 * 60 * 60
  );
}

export async function getTeamRankings(sportSlug, season) {
  if (["nfl", "nba", "mlb"].includes(sportSlug)) return getStandingsRankings(sportSlug, season);
  if (["ncaaf", "ncaab"].includes(sportSlug)) return getPollRankings(sportSlug, season);
  return {};
}

// Turns whatever getTeamRankings(...) returned into a short display label for
// one team, or null if that team has no rank to show (unranked college teams
// show nothing — that's the correct, expected state, not a data problem).
export function lookupRankLabel(sportSlug, rankings, teamFullName) {
  if (!rankings) return null;
  try {
    if (["nfl", "nba", "mlb"].includes(sportSlug)) {
      const code = toTeamCode(sportSlug, teamFullName);
      const entry = rankings[code];
      return entry ? entry.label : null;
    }
    if (["ncaaf", "ncaab"].includes(sportSlug)) {
      const norm = normalizeSchoolName(teamFullName);
      if (rankings[norm] !== undefined) return `#${rankings[norm]}`;
      for (const key of Object.keys(rankings)) {
        if (!key) continue;
        if (norm.includes(key) || key.includes(norm)) return `#${rankings[key]}`;
      }
      return null;
    }
  } catch (err) {
    console.error("lookupRankLabel failed:", err.message);
  }
  return null;
}

// NFL only for now (that's what was asked for) — true when both teams share
// the same division, so the Board can call out a divisional matchup. NBA and
// MLB have the same `division` data sitting in `rankings` already, so this
// is a one-line change to extend later if that's wanted too.
export function isDivisionGame(sportSlug, rankings, homeTeam, awayTeam) {
  if (sportSlug !== "nfl" || !rankings) return false;
  try {
    const homeDiv = rankings[toTeamCode(sportSlug, homeTeam)]?.division;
    const awayDiv = rankings[toTeamCode(sportSlug, awayTeam)]?.division;
    return !!homeDiv && !!awayDiv && homeDiv === awayDiv;
  } catch (err) {
    console.error("isDivisionGame failed:", err.message);
    return false;
  }
}
