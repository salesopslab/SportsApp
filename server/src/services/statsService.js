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
  return cached(`schedule:${sportSlug}:${season}`, () => fetchSeasonSchedule(sportSlug, season));
}

// MLB's Schedules endpoint 404s on a bare year ("2026") — SportsData.io's own
// docs say the season parameter needs a season-type suffix there ("2026REG"
// for regular season, "2026POST" for postseason; confirmed via their workflow
// guide, not guessed). Every other sport here accepts the bare year fine, so
// this only branches for MLB, and only when the caller passed a bare year
// (a caller that already passed an explicit "...REG"/"...POST" is left alone).
// Merges regular season + postseason so head-to-head/pitcher lookups keep
// working correctly no matter where in the calendar "today" falls (e.g. late
// September, when the regular season is wrapping up and the postseason is
// starting at the same time).
async function fetchSeasonSchedule(sportSlug, season) {
  if (sportSlug === "mlb" && /^\d{4}$/.test(String(season))) {
    const [reg, post] = await Promise.all([
      sdioGet(sportSlug, `scores/json/Schedules/${season}REG`).catch((err) => {
        console.error(`getSeasonSchedule(mlb, ${season}REG) failed:`, err.message);
        return [];
      }),
      sdioGet(sportSlug, `scores/json/Schedules/${season}POST`).catch((err) => {
        console.error(`getSeasonSchedule(mlb, ${season}POST) failed:`, err.message);
        return [];
      }),
    ]);
    return [...(reg || []), ...(post || [])];
  }
  return sdioGet(sportSlug, `scores/json/Schedules/${season}`);
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

// SportsData.io's NFL Standings returns a bare Division ("East") alongside a
// separate Conference ("AFC") — confirmed against the real, deployed API
// response, which was showing "1st East" instead of "1st AFC East" before
// this combined the two. The combined string doubles as the value used for
// division-game matching below, which matters: comparing the bare "East"
// would wrongly call an AFC East vs. NFC East matchup a division game, since
// both divisions share that same bare name.
function buildDivisionLabel(sportSlug, r) {
  const division = r.Division || "";
  if (!division) return r.Conference || r.League || "";
  // Defensive: if the API's Division field ever comes back already
  // conference-qualified ("AL East" rather than "East"), don't double it up.
  const alreadyQualified = (prefix) => prefix && division.toLowerCase().startsWith(prefix.toLowerCase());
  if (sportSlug === "nfl") {
    const conf = r.Conference || "";
    return conf && !alreadyQualified(conf) ? `${conf} ${division}` : division;
  }
  if (sportSlug === "mlb") {
    const league = r.League || r.Conference || "";
    return league && !alreadyQualified(league) ? `${league} ${division}` : division;
  }
  // NBA divisions (Atlantic, Pacific, ...) are unique on their own — no
  // conference prefix needed, and that's also the conventional way people say them.
  return division;
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
          const group = buildDivisionLabel(sportSlug, r);
          map[code] = {
            rank,
            label: group ? `${ordinal(rank)} ${group}` : ordinal(rank),
            division: group || null,
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

// CFB/CBB: SportsData.io doesn't have a separate "Rankings" endpoint for
// either sport (an earlier version of this guessed one and got a 404 in
// production) — the current AP rank lives right on each team's record in the
// Teams endpoint instead (confirmed against SportsData.io's own data
// dictionary: the Team object carries ApRank, and for CFB a CoachesRank too).
// Keyed by a normalized school name for best-effort matching against
// whatever spelling the odds feed uses (college team naming isn't as
// standardized as the pro leagues' abbreviations).
async function getPollRankings(sportSlug) {
  return cached(
    `poll-rank:${sportSlug}`,
    async () => {
      try {
        const teams = await sdioGet(sportSlug, "scores/json/Teams");
        const map = {};
        for (const t of teams || []) {
          const rank = t.ApRank ?? t.CoachesRank ?? null;
          const name = t.School;
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
  if (["ncaaf", "ncaab"].includes(sportSlug)) return getPollRankings(sportSlug);
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

// ---------------------------------------------------------------------------
// MLB starting/probable pitchers for the Board — built from the same season
// schedule data already fetched for head-to-head (scores/json/Schedules),
// so this doesn't cost an extra API call. SportsData.io populates the
// "Probable" pitcher fields ahead of first pitch and swaps to the
// "StartingPitcher" fields once it's confirmed/the game is underway; field
// names have varied across SportsData.io sports/endpoints in the past (see
// the CFB/CBB rankings fix above), so this checks every variant we know of
// rather than trusting one and 404-ing or silently showing nothing.
// ---------------------------------------------------------------------------
function pitcherName(g, side) {
  return (
    g[`${side}TeamStartingPitcher`] ||
    g[`${side}TeamProbablePitcher`] ||
    g[`${side}StartingPitcher`] ||
    g[`${side}ProbablePitcher`] ||
    null
  );
}

// Keyed by "AWAY@HOME:YYYY-MM-DD" (team codes + calendar date of the game),
// same team-code convention the schedule already uses for head-to-head
// matching. MLB-only; every other sport resolves to an empty map for free.
export async function getProbablePitchers(sportSlug, season) {
  if (sportSlug !== "mlb") return {};
  try {
    const schedule = await getSeasonSchedule(sportSlug, season);
    const map = {};
    for (const g of schedule || []) {
      const home = g.HomeTeam;
      const away = g.AwayTeam;
      const dateStr = String(g.Day || g.DateTime || "").slice(0, 10);
      if (!home || !away || !dateStr) continue;
      const homePitcher = pitcherName(g, "Home");
      const awayPitcher = pitcherName(g, "Away");
      if (!homePitcher && !awayPitcher) continue;
      map[`${away}@${home}:${dateStr}`] = { homePitcher, awayPitcher };
    }
    return map;
  } catch (err) {
    console.error(`getProbablePitchers(${sportSlug}) failed:`, err.message);
    return {};
  }
}

// Looks up a specific game's pitchers from the map above, matching by team
// code + date. Checks the day before/after too — MLB doubleheaders and a
// game's date landing on either side of a UTC-vs-local boundary both mean
// the schedule's date string can be one day off from commenceTime's.
export function lookupPitchers(sportSlug, pitcherMap, homeTeamFullName, awayTeamFullName, commenceTime) {
  if (sportSlug !== "mlb" || !pitcherMap) return null;
  try {
    const home = toTeamCode(sportSlug, homeTeamFullName);
    const away = toTeamCode(sportSlug, awayTeamFullName);
    const base = new Date(commenceTime);
    for (const offsetDays of [0, -1, 1]) {
      const d = new Date(base);
      d.setUTCDate(d.getUTCDate() + offsetDays);
      const key = `${away}@${home}:${d.toISOString().slice(0, 10)}`;
      if (pitcherMap[key]) return pitcherMap[key];
    }
    return null;
  } catch (err) {
    console.error("lookupPitchers failed:", err.message);
    return null;
  }
}
