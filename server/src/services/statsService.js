import { cached } from "./cache.js";
import { toTeamCode } from "../data/teamCodes.js";

const KEY = process.env.SPORTSDATA_API_KEY;

// This app's internal sport slugs ("ncaaf"/"ncaab", shared with the-odds-api
// sport keys) don't match SportsData.io's own URL segments for college sports
// ("cfb"/"cbb") — confirmed live against the real API: /v3/ncaaf/... 404s,
// /v3/cfb/... works. Every SportsData.io call in this file goes through
// sdioGet, so fixing the segment here fixes it everywhere at once (poll
// rankings, injuries, team stats, schedules, live state) rather than needing
// a patch per function.
const SDIO_SPORT_SEGMENT = { ncaaf: "cfb", ncaab: "cbb" };

async function sdioGet(sportSlug, path) {
  const segment = SDIO_SPORT_SEGMENT[sportSlug] || sportSlug;
  const url = `https://api.sportsdata.io/v3/${segment}/${path}`;
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

// MLB doesn't use the "Schedules" resource the other sports in this file use
// — confirmed directly against the live API (not guessed): "Games" is the
// correct resource, and it needs a season-TYPE-suffixed year ("2026REG",
// "2026POST"), not a bare one. Merges regular season + postseason so
// head-to-head/pitcher lookups keep working correctly no matter where in the
// calendar "today" falls (e.g. late September, when the regular season is
// wrapping up and the postseason is starting at the same time).
//
// CFB/CBB have the same "Schedules" 404 problem (confirmed live), but their
// fix is simpler: "Games/{bare year}" with no REG/POST suffix returns the
// whole season (confirmed live: 953 CFB games, 6,516 CBB games for 2026).
async function fetchSeasonSchedule(sportSlug, season) {
  if (sportSlug === "ncaaf" || sportSlug === "ncaab") {
    const bareYear = String(season).replace(/(REG|POST|PRE)$/, "");
    return sdioGet(sportSlug, `scores/json/Games/${bareYear}`);
  }

  if (sportSlug !== "mlb") return sdioGet(sportSlug, `scores/json/Schedules/${season}`);

  const bareYear = String(season).replace(/(REG|POST|PRE)$/, "");
  const [reg, post] = await Promise.all([
    sdioGet("mlb", `scores/json/Games/${bareYear}REG`).catch((err) => {
      console.error(`getSeasonSchedule(mlb, ${bareYear}REG) failed:`, err.message);
      return [];
    }),
    sdioGet("mlb", `scores/json/Games/${bareYear}POST`).catch((err) => {
      console.error(`getSeasonSchedule(mlb, ${bareYear}POST) failed:`, err.message);
      return [];
    }),
  ]);
  return [...(Array.isArray(reg) ? reg : []), ...(Array.isArray(post) ? post : [])];
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
// schedule data already fetched for head-to-head (scores/json/Games), so this
// doesn't cost an extra API call for the schedule itself.
//
// Confirmed directly against the live API (not guessed): the Games resource's
// convenience name fields (HomeTeamStartingPitcher, etc.) are unreliable as a
// presence check — on at least some SportsData.io accounts they come back as
// a fixed placeholder string regardless of whether real data exists behind
// them. The corresponding *ID* fields (HomeTeamProbablePitcherID,
// HomeTeamStartingPitcherID) are the trustworthy signal: null really means
// "not set yet." So pitcher name resolution always goes through the player-ID
// -> name lookup below rather than trusting a name field directly off the
// game object — that also means it keeps working even on accounts where the
// convenience name fields are scrambled/anonymized.
// ---------------------------------------------------------------------------

// One-time (long-cached) roster pull so resolving pitcher IDs to names never
// costs a per-player API call. Keyed by PlayerID.
async function getPlayerNameMap(sportSlug) {
  return cached(
    `players:${sportSlug}`,
    async () => {
      try {
        const players = await sdioGet(sportSlug, "scores/json/Players");
        const map = {};
        for (const p of players || []) {
          if (!p.PlayerID) continue;
          const name = [p.FirstName, p.LastName].filter(Boolean).join(" ").trim();
          if (name) map[p.PlayerID] = name;
        }
        return map;
      } catch (err) {
        console.error(`getPlayerNameMap(${sportSlug}) failed:`, err.message);
        return {};
      }
    },
    12 * 60 * 60 // rosters barely change hour to hour — 12h cache is plenty fresh
  );
}

// Season pitching line (W-L, ERA) for every MLB pitcher, from MLB's official
// Stats API (free, no key). Not from SportsData.io: this account anonymizes
// some player fields, and a scrambled ERA on a betting board is worse than
// none. One cached call for the whole league, keyed by normalized full name
// (accents, punctuation and Jr./Sr. stripped). Regular-season numbers even
// during the postseason, since that's the line people quote for a starter.
// Any failure -> empty map, and the Board just shows the name.
const MLB_STATS_URL = "https://statsapi.mlb.com/api/v1/stats";
export function pitcherNameKey(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function parseMlbPitchingStats(json, year) {
  const map = {};
  for (const block of json?.stats || []) {
    for (const sp of block.splits || []) {
      const name = sp.player?.fullName;
      const st = sp.stat || {};
      const w = Number(st.wins), l = Number(st.losses);
      if (!name || !Number.isFinite(w) || !Number.isFinite(l)) continue;
      const era = st.era != null && /^\d+(\.\d+)?$/.test(String(st.era)) ? Number(st.era).toFixed(2) : null;
      const key = pitcherNameKey(name);
      const team = sp.team?.name ? toTeamCode("mlb", sp.team.name) : null;
      // One row per pitcher (a traded pitcher's row carries his current team).
      // Two different pitchers can share a name, so keep every one.
      (map[key] ||= []).push({ id: sp.player?.id ?? null, team, wins: w, losses: l, era, season: String(year), source: "MLB Stats API" });
    }
  }
  return map;
}

// The season line for a named starter. If two pitchers share the name, the
// team breaks the tie; if it still can't, return null rather than risk
// showing someone else's ERA.
export function lookupPitcherStats(statsMap, name, teamCode) {
  const rows = statsMap?.[pitcherNameKey(name)];
  if (!rows?.length) return null;
  const pick = rows.length === 1 ? rows[0] : rows.filter((r) => r.team && r.team === teamCode).length === 1 ? rows.find((r) => r.team === teamCode) : null;
  if (!pick) return null;
  const { wins, losses, era, season, source } = pick;
  return { wins, losses, era, season, source };
}
let fetchMlbStats = (url) => fetch(url, { headers: { Accept: "application/json" } });
export function __setMlbStatsFetch(fn) { fetchMlbStats = fn; }
export async function getPitcherSeasonStats(sportSlug, season) {
  if (sportSlug !== "mlb") return {};
  const year = String(season).replace(/(REG|POST|PRE)$/, "");
  return cached(
    `pitcher-stats:mlb:${year}`,
    async () => {
      try {
        const url = `${MLB_STATS_URL}?stats=season&group=pitching&season=${year}&sportId=1&gameType=R&playerPool=ALL&limit=3000`;
        const res = await fetchMlbStats(url);
        if (!res.ok) throw new Error(`MLB Stats API ${res.status}`);
        return parseMlbPitchingStats(await res.json(), year);
      } catch (err) {
        console.error(`getPitcherSeasonStats(${year}) failed:`, err.message);
        return {};
      }
    },
    3 * 60 * 60 // a starter's line only changes once per start
  );
}

// Prefer the probable pitcher (announced ahead of the game) and fall back to
// the confirmed starter (set once the game is underway/closer to first
// pitch) — whichever ID is actually populated. Never fabricates a name: a
// missing ID (not announced yet) or an ID this roster pull doesn't recognize
// both resolve to null rather than a guess.
function pitcherId(g, side) {
  return g[`${side}TeamProbablePitcherID`] || g[`${side}TeamStartingPitcherID`] || null;
}

// Keyed by "AWAY@HOME:YYYY-MM-DD" (team codes + calendar date of the game),
// same team-code convention the schedule already uses for head-to-head
// matching. MLB-only; every other sport resolves to an empty map for free.
export async function getProbablePitchers(sportSlug, season) {
  if (sportSlug !== "mlb") return {};
  try {
    const [schedule, playerNames, pitcherStats] = await Promise.all([
      getSeasonSchedule(sportSlug, season),
      getPlayerNameMap(sportSlug),
      getPitcherSeasonStats(sportSlug, season),
    ]);
    const map = {};
    for (const g of schedule || []) {
      const home = g.HomeTeam;
      const away = g.AwayTeam;
      const dateStr = String(g.Day || g.DateTime || "").slice(0, 10);
      if (!home || !away || !dateStr) continue;
      const homeId = pitcherId(g, "Home");
      const awayId = pitcherId(g, "Away");
      const homePitcher = homeId ? playerNames[homeId] || null : null;
      const awayPitcher = awayId ? playerNames[awayId] || null : null;
      if (!homePitcher && !awayPitcher) continue;
      map[`${away}@${home}:${dateStr}`] = {
        homePitcher,
        awayPitcher,
        homePitcherStats: homePitcher ? lookupPitcherStats(pitcherStats, homePitcher, home) : null,
        awayPitcherStats: awayPitcher ? lookupPitcherStats(pitcherStats, awayPitcher, away) : null,
      };
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

// ---------------------------------------------------------------------------
// Live game state — quarter/period, clock, down & distance, balls/strikes/
// outs — for the Board's "live" rows.
//
// Confirmed directly against the live API (not guessed), Sept 27 2026, during
// actual in-progress NFL and MLB games: our existing SportsData.io key
// already returns real values for every field this uses. Only a few
// cosmetic/text fields are anonymized on this account (the raw numeric Down,
// the free-text LastPlay description, player names) — none of which this
// needs, since DownAndDistance ("3rd & 7") is itself a real, unscrambled
// convenience field. So this works today, on the same key already used for
// pitchers, with no plan/cost change required to show it.
// ---------------------------------------------------------------------------

function todayYMD() {
  return new Date().toISOString().slice(0, 10);
}

function clockLabel(minutes, seconds) {
  if (minutes === null || minutes === undefined || seconds === null || seconds === undefined) return null;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function mlbInningLabel(half, inning) {
  if (!inning) return null;
  const label = { T: "Top", B: "Bot", M: "Mid", E: "End" }[half] || "";
  return `${label} ${ordinal(inning)}`.trim();
}

async function fetchLiveByDate(sportSlug, date) {
  // NFL is the one sport in this account where "ScoresByDate" (not
  // "GamesByDate") is the resource that carries the live Quarter/
  // TimeRemaining/DownAndDistance fields — confirmed live.
  if (sportSlug === "nfl") return sdioGet(sportSlug, `scores/json/ScoresByDate/${date}`);
  return sdioGet(sportSlug, `scores/json/GamesByDate/${date}`);
}

function buildNflCfbLiveEntry(g) {
  const inProgress = g.IsInProgress === true || g.Status === "InProgress";
  if (!inProgress) return null;
  const quarterLabel = g.QuarterDescription || (g.Quarter ? `Q${g.Quarter}` : g.Period ? `Q${g.Period}` : null);
  const clock = g.TimeRemaining || clockLabel(g.TimeRemainingMinutes, g.TimeRemainingSeconds);
  const line = [quarterLabel, clock].filter(Boolean).join(" ") || null;
  if (!line) return null;
  const detail = g.DownAndDistance && g.Possession
    ? `${g.DownAndDistance}${g.YardLine ? ` at ${g.Possession} ${g.YardLine}` : ""}`
    : null;
  return { line, detail };
}

function buildMlbLiveEntry(g) {
  if (g.Status !== "InProgress") return null;
  const line = mlbInningLabel(g.InningHalf, g.Inning);
  if (!line) return null;
  const parts = [];
  if (g.Outs !== null && g.Outs !== undefined) parts.push(`${g.Outs} out${g.Outs === 1 ? "" : "s"}`);
  if (g.Balls !== null && g.Balls !== undefined && g.Strikes !== null && g.Strikes !== undefined) {
    parts.push(`${g.Balls}-${g.Strikes} count`);
  }
  return { line, detail: parts.length ? parts.join(" • ") : null };
}

function buildHoopsLiveEntry(g) {
  if (g.Status !== "InProgress") return null;
  const period = g.Quarter || g.Period;
  if (!period) return null;
  const periodLabel = /^\d+$/.test(String(period)) ? `Q${period}` : String(period);
  const clock = clockLabel(g.TimeRemainingMinutes, g.TimeRemainingSeconds);
  const line = [periodLabel, clock].filter(Boolean).join(" ") || null;
  if (!line) return null;
  return { line, detail: null };
}

// Keyed by team code ("code:AWAY@HOME") for NFL/MLB/NBA, or normalized school
// name ("name:away@home") for CFB/CBB — SportsData's college team names don't
// reliably line up with the odds feed's naming, same reasoning as the poll
// rankings matching above. Cached briefly (20s): this is live, time-sensitive
// data, unlike the multi-hour caches elsewhere in this file.
export async function getLiveGameState(sportSlug) {
  if (!["nfl", "mlb", "nba", "ncaaf", "ncaab"].includes(sportSlug)) return {};
  return cached(
    `livestate:${sportSlug}:${todayYMD()}`,
    async () => {
      try {
        const games = await fetchLiveByDate(sportSlug, todayYMD());
        const map = {};
        let inProgressSeen = 0;
        for (const g of games || []) {
          let entry = null;
          if (sportSlug === "nfl" || sportSlug === "ncaaf") entry = buildNflCfbLiveEntry(g);
          else if (sportSlug === "mlb") entry = buildMlbLiveEntry(g);
          else entry = buildHoopsLiveEntry(g);
          if (g.Status === "InProgress" || g.IsInProgress === true) inProgressSeen++;
          if (!entry) continue;

          if (sportSlug === "nfl" || sportSlug === "mlb" || sportSlug === "nba") {
            const away = toTeamCode(sportSlug, g.AwayTeam) || g.AwayTeam;
            const home = toTeamCode(sportSlug, g.HomeTeam) || g.HomeTeam;
            map[`code:${away}@${home}`] = entry;
          } else {
            const away = normalizeSchoolName(g.AwayTeamName || g.AwayTeam);
            const home = normalizeSchoolName(g.HomeTeamName || g.HomeTeam);
            map[`name:${away}@${home}`] = entry;
          }
        }
        // Temporary diagnostic: MLB live state has come back empty in
        // production despite the same call/key/code working when tested
        // directly, and with no thrown error to explain why. This line
        // narrows it down next time it runs: 0 games fetched points to a
        // request/auth issue for this specific call; games fetched but 0
        // in-progress/0 entries points to a data-shape or key-matching issue.
        console.log(
          `getLiveGameState(${sportSlug}): fetched ${Array.isArray(games) ? games.length : 0} games, ${inProgressSeen} in progress, built ${Object.keys(map).length} live-state entries`
        );
        return map;
      } catch (err) {
        console.error(`getLiveGameState(${sportSlug}) failed:`, err.message);
        return {};
      }
    },
    20
  );
}

// Never fabricates: a game the provider doesn't have live state for yet (or
// at all) resolves to null, and the Board falls back to its existing generic
// "Live" badge/note for that row.
export function lookupLiveState(sportSlug, liveMap, homeTeamFullName, awayTeamFullName) {
  if (!liveMap) return null;
  try {
    if (sportSlug === "nfl" || sportSlug === "mlb" || sportSlug === "nba") {
      const home = toTeamCode(sportSlug, homeTeamFullName);
      const away = toTeamCode(sportSlug, awayTeamFullName);
      return liveMap[`code:${away}@${home}`] || null;
    }
    if (sportSlug === "ncaaf" || sportSlug === "ncaab") {
      const home = normalizeSchoolName(homeTeamFullName);
      const away = normalizeSchoolName(awayTeamFullName);
      return liveMap[`name:${away}@${home}`] || null;
    }
  } catch (err) {
    console.error("lookupLiveState failed:", err.message);
  }
  return null;
}
