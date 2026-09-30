import { cachedWithMeta, invalidate } from "./cache.js";
import { getTeamInjuryReports, normalizePlayerName } from "./injuryService.js";
import { getOddsForSportWithMeta } from "./oddsService.js";
import { getGameWeather } from "./weatherService.js";
import { getTeamSeasonStats } from "./statsService.js";
import { VENUES } from "../data/venues.js";
import { toTeamCode } from "../data/teamCodes.js";

// ---------------------------------------------------------------------------
// Fantasy Edge player data (NFL).
//
// Reuses BetEdge's existing feeds wherever possible:
//   - injuries: injuryService (ESPN primary, SportsDataIO secondary, conflicts kept)
//   - game environment: oddsService (spread/total, kickoff) + weatherService
//   - opponent defense: SportsDataIO team season stats
// and adds ESPN's public roster / depth chart / game log endpoints for
// player identity, role and recent usage.
//
// Rules (same spirit as injuryService):
//   1. Every player carries status + source + last updated.
//   2. A player not on an injury report is "STATUS UNCONFIRMED", never "healthy".
//   3. Source disagreements are surfaced as conflicts, not silently resolved.
//   4. Anything we couldn't retrieve is reported as unavailable, never guessed.
// ---------------------------------------------------------------------------

const SPORT = "nfl";
const ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";
const ESPN_WEB = "https://site.web.api.espn.com/apis/common/v3/sports/football/nfl";

const ROSTER_TTL = 6 * 60 * 60; // rosters move slowly
const DEPTH_TTL = 60 * 60; // depth charts can change midweek
const GAMELOG_TTL = 60 * 60;
const TEAMS_TTL = 24 * 60 * 60;

export const FANTASY_POSITIONS = ["QB", "RB", "WR", "TE", "K", "DEF"];

const ESPN_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.espn.com/",
  Origin: "https://www.espn.com",
};

// Swappable for tests.
let fetchImpl = (...args) => fetch(...args);
export function __setFetch(fn) {
  fetchImpl = fn;
}

async function espnJson(url) {
  const res = await fetchImpl(url, { headers: ESPN_HEADERS });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ESPN ${res.status} for ${url}: ${body.slice(0, 160)}`);
  }
  return res.json();
}

export function currentNflSeason(now = new Date()) {
  // The NFL season spills into Jan/Feb of the next calendar year.
  return now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
}

const norm = normalizePlayerName;

function lastName(name) {
  const parts = norm(name).split(" ");
  return parts[parts.length - 1] || "";
}

// ---- Teams + rosters -------------------------------------------------------

async function getEspnTeams() {
  const meta = await cachedWithMeta(
    "fantasy:espn-teams",
    async () => {
      const data = await espnJson(`${ESPN_SITE}/teams`);
      const teams = (data?.sports?.[0]?.leagues?.[0]?.teams || []).map((t) => t.team).filter(Boolean);
      if (!teams.length) throw new Error("ESPN teams response had no teams");
      return teams.map((t) => ({ id: String(t.id), abbr: t.abbreviation, name: t.displayName }));
    },
    TEAMS_TTL
  );
  return meta.value;
}

export async function resolveTeam(input) {
  if (!input) return null;
  const teams = await getEspnTeams();
  const q = norm(input);
  return (
    teams.find((t) => norm(t.name) === q) ||
    teams.find((t) => norm(t.abbr) === q) ||
    teams.find((t) => lastName(t.name) === lastName(input)) ||
    teams.find((t) => norm(t.name).includes(q)) ||
    null
  );
}

async function getTeamRoster(team) {
  return cachedWithMeta(
    `fantasy:roster:${team.id}`,
    async () => {
      const data = await espnJson(`${ESPN_SITE}/teams/${team.id}/roster`);
      const players = [];
      for (const group of data?.athletes || []) {
        for (const a of group.items || []) {
          players.push({
            espnId: String(a.id),
            name: a.displayName || a.fullName,
            position: a.position?.abbreviation || null,
            team: team.name,
            teamAbbr: team.abbr,
            teamId: team.id,
            jersey: a.jersey || null,
            // ESPN's roster also carries its own injury flag — kept as a
            // second opinion for conflict detection, not as the primary status.
            rosterInjury: a.injuries?.[0]?.status || null,
            rosterInjuryDate: a.injuries?.[0]?.date || null,
          });
        }
      }
      return players;
    },
    ROSTER_TTL
  );
}

// All 32 rosters (cached) → a name index. First call is ~32 requests in
// parallel; afterwards it's served from cache for hours.
async function getPlayerIndex() {
  const teams = await getEspnTeams();
  const results = await Promise.allSettled(teams.map((t) => getTeamRoster(t)));
  const players = [];
  const failedTeams = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") players.push(...r.value.value);
    else failedTeams.push(teams[i].name);
  });
  return { players, failedTeams };
}

// Common nicknames / alternate spellings fantasy apps use -> roster name.
const NAME_ALIASES = {
  "hollywood brown": "marquise brown",
  "gabe davis": "gabriel davis",
  "chig okonkwo": "chigoziem okonkwo",
  "tank dell": "nathaniel dell",
  "mike williams": "mike williams",
  "kenneth walker": "kenneth walker",
  "bam knight": "zonovan knight",
  "scotty miller": "scott miller",
  "josh palmer": "joshua palmer",
  "dj moore": "d j moore",
  "dk metcalf": "d k metcalf",
  "cj stroud": "c j stroud",
};

// Splits a normalized query into leading initials and the surname part:
// "a st brown" -> { initials: "a", surname: "st brown" }.
function splitInitials(qNorm) {
  const parts = qNorm.split(" ");
  const initials = [];
  while (parts.length > 1 && parts[0].length === 1) initials.push(parts.shift());
  return { initials: initials.join(""), surname: parts.join(" ") };
}

export function normalizeQueryName(name) {
  let q = norm(name);
  if (NAME_ALIASES[q]) q = NAME_ALIASES[q];
  return q;
}

function scoreNameMatch(player, qNorm, qLast) {
  const pn = norm(player.name);
  if (pn === qNorm) return 100;
  const squash = (x) => x.replace(/ /g, "");
  if (squash(pn) === squash(qNorm)) return 95; // "aj dillon" vs "a j dillon"
  const { initials, surname } = splitInitials(qNorm);
  if (initials && surname) {
    // "A. St. Brown" -> first initial A + name ending in "st brown".
    const endsWithSurname = pn === surname || pn.endsWith(" " + surname) || squash(pn).endsWith(squash(surname));
    if (endsWithSurname && squash(pn).startsWith(initials)) return surname.includes(" ") ? 88 : 80;
    if (endsWithSurname && pn[0] === initials[0]) return 78;
  }
  const [qFirst] = qNorm.split(" ");
  if (lastName(player.name) === qLast && qFirst && pn.startsWith(qFirst[0])) return 75;
  if (lastName(player.name) === qLast) return 60;
  if (pn.includes(qNorm)) return 50;
  return 0;
}

const fantasyRank = (p) => (FANTASY_POSITIONS.includes(p.position) || p.position === "PK" ? 0 : 1);
const posMatches = (p, position) => {
  const want = String(position).toUpperCase();
  const have = p.position === "PK" ? "K" : p.position === "FB" ? "RB" : p.position;
  return have === (want === "PK" ? "K" : want);
};

function bestMatch(pool, qNorm, qLast) {
  const scored = pool
    .map((p) => ({ p, s: scoreNameMatch(p, qNorm, qLast) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || fantasyRank(a.p) - fantasyRank(b.p));
  if (!scored.length) return { player: null, candidates: [] };
  const top = scored[0];
  const ties = scored.filter((x) => x.s === top.s && fantasyRank(x.p) === fantasyRank(top.p));
  if (ties.length > 1 && top.s < 100) return { player: null, candidates: ties.slice(0, 5).map((x) => x.p), ambiguous: true };
  return { player: top.p, candidates: [], score: top.s };
}

// Finds a player by name (optionally narrowed by team / position).
// Tries the narrowest filter first and relaxes it if nothing matches, so a
// wrong team abbreviation or position read from a screenshot doesn't lose
// the player. Returns { player, candidates } — candidates are listed when the
// name is ambiguous so the caller can ask which one.
export async function findPlayer(name, { team, position } = {}) {
  const qNorm = normalizeQueryName(name);
  if (!qNorm) return { player: null, candidates: [], error: "No player name given." };
  const { players, failedTeams } = await getPlayerIndex();
  const teamObj = team ? await resolveTeam(team).catch(() => null) : null;
  const qLast = lastName(qNorm);
  const byTeam = teamObj ? players.filter((p) => p.teamId === teamObj.id) : null;
  const attempts = [];
  if (byTeam && position) attempts.push(byTeam.filter((p) => posMatches(p, position)));
  if (byTeam) attempts.push(byTeam);
  if (position) attempts.push(players.filter((p) => posMatches(p, position)));
  attempts.push(players);
  let lastAmbiguous = null;
  for (const pool of attempts) {
    if (!pool.length) continue;
    const r = bestMatch(pool, qNorm, qLast);
    if (r.player) return { player: r.player, candidates: [], score: r.score };
    if (r.ambiguous && !lastAmbiguous) lastAmbiguous = r;
  }
  if (lastAmbiguous) return { player: null, candidates: lastAmbiguous.candidates, error: "More than one player matches that name." };
  return {
    player: null,
    candidates: [],
    error: failedTeams.length
      ? `Player not found. Rosters for ${failedTeams.length} team(s) could not be loaded, so the player may be on one of them.`
      : "Player not found on current NFL rosters.",
  };
}

// ---- Depth charts ----------------------------------------------------------

// ESPN depth chart → { QB: [names in order], RB: [...], WR: [...], TE: [...], K: [...] }.
// ESPN splits WR into several slots (e.g. LWR/RWR/SWR) — merged by rank.
export function parseDepthChart(data) {
  const out = {};
  const formations = data?.depthchart || data?.items || [];
  const buckets = {};
  for (const f of formations) {
    for (const [key, slot] of Object.entries(f.positions || {})) {
      const abbr = String(slot?.position?.abbreviation || key).toUpperCase();
      let pos = abbr;
      if (/WR$/.test(abbr)) pos = "WR";
      else if (abbr === "PK") pos = "K";
      else if (/^(RB|HB)$/.test(abbr)) pos = "RB";
      if (!["QB", "RB", "WR", "TE", "K"].includes(pos)) continue;
      (slot.athletes || []).forEach((a, i) => {
        const nm = a.displayName || a.fullName || a.athlete?.displayName;
        if (!nm) return;
        (buckets[pos] ||= []).push({ name: nm, rank: a.rank ?? i + 1 });
      });
    }
  }
  for (const [pos, list] of Object.entries(buckets)) {
    const seen = new Set();
    out[pos] = list
      .sort((a, b) => a.rank - b.rank)
      .filter((x) => !seen.has(norm(x.name)) && seen.add(norm(x.name)))
      .map((x) => x.name);
  }
  return out;
}

export async function getDepthChart(team, { forceRefresh = false } = {}) {
  const key = `fantasy:depth:${team.id}`;
  if (forceRefresh) invalidate(key);
  try {
    const meta = await cachedWithMeta(
      key,
      async () => {
        const data = await espnJson(`${ESPN_SITE}/teams/${team.id}/depthcharts`);
        const chart = parseDepthChart(data);
        if (!Object.keys(chart).length) throw new Error("ESPN depth chart response was empty");
        return chart;
      },
      DEPTH_TTL
    );
    return { status: "ok", team: team.name, chart: meta.value, source: "ESPN", retrieved_at: meta.retrievedAt };
  } catch (err) {
    return { status: "unavailable", team: team.name, chart: {}, source: null, retrieved_at: null, error: err.message };
  }
}

// ---- Game logs + fantasy points -------------------------------------------

export const SCORING = {
  ppr: { label: "PPR", rec: 1 },
  half: { label: "Half PPR", rec: 0.5 },
  standard: { label: "Standard", rec: 0 },
};

export function normalizeScoring(s) {
  const v = String(s || "").toLowerCase().replace(/[^a-z]/g, "");
  if (v.startsWith("half")) return "half";
  if (v === "standard" || v === "std" || v === "nonppr") return "standard";
  return "ppr";
}

// Standard fantasy scoring. Only uses stats that are actually present.
export function fantasyPoints(s, scoring = "ppr") {
  const rec = SCORING[normalizeScoring(scoring)].rec;
  const n = (k) => (Number.isFinite(Number(s[k])) ? Number(s[k]) : 0);
  const pts =
    n("passingYards") * 0.04 +
    n("passingTouchdowns") * 4 -
    n("interceptions") * 2 +
    n("rushingYards") * 0.1 +
    n("rushingTouchdowns") * 6 +
    n("receptions") * rec +
    n("receivingYards") * 0.1 +
    n("receivingTouchdowns") * 6 -
    n("fumblesLost") * 2;
  return Math.round(pts * 10) / 10;
}

const STAT_KEYS = [
  "completions", "passingAttempts", "passingYards", "passingTouchdowns", "interceptions",
  "rushingAttempts", "rushingYards", "rushingTouchdowns",
  "receptions", "receivingTargets", "receivingYards", "receivingTouchdowns",
  "fumblesLost",
];

// ESPN's game log: top-level `names` lines up with each event's `stats`.
export function parseGameLog(data, limit = 5) {
  const names = data?.names || [];
  const eventsMeta = data?.events || {};
  const rows = [];
  const regular = (data?.seasonTypes || []).filter((st) => !/pre/i.test(st.displayName || ""));
  for (const st of regular.length ? regular : data?.seasonTypes || []) {
    for (const cat of st.categories || []) {
      for (const ev of cat.events || []) {
        const stats = {};
        (ev.stats || []).forEach((v, i) => {
          const k = names[i];
          if (!k) return;
          const num = Number(String(v).replace(/,/g, ""));
          if (STAT_KEYS.includes(k) && Number.isFinite(num)) stats[k] = num;
        });
        const m = eventsMeta[ev.eventId] || {};
        rows.push({
          eventId: ev.eventId,
          date: m.gameDate || null,
          week: m.week ?? null,
          opponent: m.opponent?.abbreviation || m.opponent?.displayName || null,
          homeAway: m.atVs === "@" ? "away" : m.atVs ? "home" : null,
          result: m.gameResult || null,
          stats,
        });
      }
    }
  }
  const seen = new Set();
  return rows
    .filter((r) => !seen.has(r.eventId) && seen.add(r.eventId))
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0))
    .slice(0, limit);
}

export async function getRecentGames(player, { season = currentNflSeason(), limit = 5 } = {}) {
  try {
    const meta = await cachedWithMeta(
      `fantasy:gamelog:${player.espnId}:${season}`,
      async () => espnJson(`${ESPN_WEB}/athletes/${player.espnId}/gamelog?season=${season}`),
      GAMELOG_TTL
    );
    return { status: "ok", games: parseGameLog(meta.value, limit), source: "ESPN", retrieved_at: meta.retrievedAt };
  } catch (err) {
    return { status: "unavailable", games: [], source: null, retrieved_at: null, error: err.message };
  }
}

function summarizeUsage(games, scoring) {
  if (!games.length) return null;
  const avg = (k) => Math.round((games.reduce((s, g) => s + (g.stats[k] || 0), 0) / games.length) * 10) / 10;
  const pts = games.map((g) => fantasyPoints(g.stats, scoring));
  const recent = pts.slice(0, 2);
  const older = pts.slice(2);
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const trend = older.length && recent.length ? Math.round((mean(recent) - mean(older)) * 10) / 10 : null;
  return {
    gamesCounted: games.length,
    avgFantasyPoints: Math.round(mean(pts) * 10) / 10,
    lastGamePoints: pts[0] ?? null,
    trendLast2VsPrior: trend, // + = trending up
    avgTargets: avg("receivingTargets"),
    avgReceptions: avg("receptions"),
    avgCarries: avg("rushingAttempts"),
    avgTouches: Math.round((avg("rushingAttempts") + avg("receptions")) * 10) / 10,
    avgPassAttempts: avg("passingAttempts"),
    totalTouchdowns: games.reduce(
      (s, g) => s + (g.stats.passingTouchdowns || 0) + (g.stats.rushingTouchdowns || 0) + (g.stats.receivingTouchdowns || 0),
      0
    ),
  };
}

// ---- Injury status per player --------------------------------------------

export function playerInjuryStatus(player, report) {
  const base = {
    designation: null,
    label: "STATUS UNCONFIRMED",
    confirmed: false,
    injury: null,
    practiceStatus: null,
    source: report?.source || null,
    source_url: report?.source_url || null,
    updated_at: null,
    retrieved_at: report?.retrieved_at || null,
    conflict: null,
    note: null,
  };
  if (!report || report.status !== "ok") {
    base.note = "Injury report could not be retrieved — current status unverified.";
    return base;
  }
  const target = norm(player.name);
  const entry = (report.players || []).find((p) => norm(p.name) === target);
  const conflict = (report.conflicts || []).find((c) => norm(c.player) === target) || null;
  if (conflict) base.conflict = conflict.reports;

  if (entry) {
    base.designation = entry.gameDesignation || null;
    base.label = (entry.gameDesignation || "LISTED").toUpperCase();
    base.confirmed = !!entry.gameDesignation;
    base.injury = entry.injury || null;
    base.practiceStatus = entry.practiceStatus || null;
    base.updated_at = entry.updated || report.last_updated || null;
    base.note = entry.note || null;
  } else {
    // Rule 2: not listed ≠ healthy.
    base.note = `Not listed on the ${report.source} injury report. That does not confirm he is healthy or active.`;
    base.updated_at = report.last_updated || null;
  }

  // Second opinion from ESPN's roster flag, if it disagrees.
  if (player.rosterInjury && norm(player.rosterInjury) !== norm(base.designation || "") && !base.conflict) {
    if (!entry || norm(player.rosterInjury) !== "active") {
      base.conflict = [
        { source: report.source, gameDesignation: base.designation || "not listed", updated: base.updated_at },
        { source: "ESPN roster", gameDesignation: player.rosterInjury, updated: player.rosterInjuryDate },
      ];
    }
  }
  return base;
}

// ---- Game environment -----------------------------------------------------

async function getUpcomingGame(teamName) {
  try {
    const meta = await getOddsForSportWithMeta(SPORT);
    const games = meta.value || meta.games || meta || [];
    const list = Array.isArray(games) ? games : [];
    const now = Date.now();
    const g = list
      .filter((x) => (x.homeTeam === teamName || x.awayTeam === teamName) && Date.parse(x.commenceTime) > now - 4 * 3600 * 1000)
      .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime))[0];
    if (!g) return { status: "unavailable", note: "No upcoming game with posted odds (bye week, or lines not posted yet)." };
    const home = g.homeTeam === teamName;
    const opponent = home ? g.awayTeam : g.homeTeam;
    const consensus = (arr) => (Array.isArray(arr) && arr.length ? arr[0] : null);
    const spreadEntry = (g.spread || []).find((s) => s.team === teamName || s.name === teamName) || consensus(g.spread);
    const totalEntry = consensus(g.total);
    const venue = VENUES[g.homeTeam];
    let weather = null;
    if (venue?.dome) weather = { conditions: "Dome — no weather impact" };
    else if (venue) weather = await getGameWeather(venue.lat, venue.lon, g.commenceTime).catch(() => null);
    return {
      status: "ok",
      gameId: g.id,
      kickoff: g.commenceTime,
      homeAway: home ? "home" : "away",
      opponent,
      spread: spreadEntry ? { team: spreadEntry.team || spreadEntry.name || null, point: spreadEntry.point ?? null, price: spreadEntry.price ?? null } : null,
      total: totalEntry ? { point: totalEntry.point ?? null } : null,
      weather,
      source: "The Odds API",
      retrieved_at: meta.retrievedAt || null,
    };
  } catch (err) {
    return { status: "unavailable", error: err.message };
  }
}

// Opponent defense: yards/points allowed per game and league rank (1 = stingiest).
async function getDefenseRanks(season) {
  try {
    const meta = await cachedWithMeta(`fantasy:defense:${season}`, () => getTeamSeasonStats(SPORT, season), 6 * 3600);
    const rows = (meta.value || []).filter((t) => t.Team && t.Games);
    const per = (t, k) => (Number(t[k]) || 0) / (Number(t.Games) || 1);
    const rank = (k) => {
      const sorted = [...rows].sort((a, b) => per(a, k) - per(b, k));
      return Object.fromEntries(sorted.map((t, i) => [t.Team, i + 1]));
    };
    const pass = rank("OpponentPassingYards");
    const rush = rank("OpponentRushingYards");
    const pts = rank("OpponentScore");
    const byTeam = {};
    for (const t of rows) {
      byTeam[t.Team] = {
        passYardsAllowedPerGame: Math.round(per(t, "OpponentPassingYards")),
        rushYardsAllowedPerGame: Math.round(per(t, "OpponentRushingYards")),
        pointsAllowedPerGame: Math.round(per(t, "OpponentScore") * 10) / 10,
        passDefenseRank: pass[t.Team],
        rushDefenseRank: rush[t.Team],
        scoringDefenseRank: pts[t.Team],
      };
    }
    return { status: "ok", byTeam, teams: rows.length, source: "SportsDataIO", retrieved_at: meta.retrievedAt };
  } catch (err) {
    return { status: "unavailable", byTeam: {}, error: err.message };
  }
}

// ---- Full player report ---------------------------------------------------

export async function getPlayerReport(name, { team, position, scoring = "ppr", forceRefresh = false } = {}) {
  const found = await findPlayer(name, { team, position });
  if (!found.player) {
    return {
      query: name,
      found: false,
      error: found.error,
      candidates: found.candidates.map((p) => ({ name: p.name, team: p.team, position: p.position })),
      status: { label: "STATUS UNCONFIRMED", confirmed: false, note: "Player could not be identified." },
    };
  }
  const player = found.player;
  const teamObj = { id: player.teamId, name: player.team, abbr: player.teamAbbr };
  const season = currentNflSeason();

  const [injuries, depth, log, game] = await Promise.all([
    getTeamInjuryReports(SPORT, [player.team], { forceRefresh }).catch(() => ({})),
    getDepthChart(teamObj, { forceRefresh }),
    getRecentGames(player, { season }),
    getUpcomingGame(player.team),
  ]);
  const report = injuries[player.team];
  const status = playerInjuryStatus(player, report);

  const posForDepth = player.position === "PK" ? "K" : player.position;
  const depthList = depth.chart?.[posForDepth] || [];
  const depthRank = depthList.findIndex((n) => norm(n) === norm(player.name));

  let opponentDefense = { status: "unavailable" };
  if (game.status === "ok") {
    const defense = await getDefenseRanks(season);
    const oppCode = toTeamCode(SPORT, game.opponent);
    const d = defense.byTeam?.[oppCode];
    opponentDefense = d
      ? { status: "ok", team: game.opponent, ...d, outOf: defense.teams, source: defense.source, retrieved_at: defense.retrieved_at }
      : { status: "unavailable", team: game.opponent, error: defense.error || "No defensive stats on file for opponent." };
  }

  const games = log.games.map((g) => ({ ...g, fantasyPoints: fantasyPoints(g.stats, scoring) }));
  return {
    query: name,
    found: true,
    player: { name: player.name, team: player.team, teamAbbr: player.teamAbbr, position: player.position, espnId: player.espnId },
    scoring: SCORING[normalizeScoring(scoring)].label,
    status,
    depthChart: {
      status: depth.status,
      position: posForDepth,
      rank: depthRank >= 0 ? depthRank + 1 : null,
      order: depthList.slice(0, 4),
      source: depth.source,
      retrieved_at: depth.retrieved_at,
      note: depth.status === "ok" && depthRank < 0 ? "Not found on the current depth chart at his listed position." : depth.error || null,
    },
    recentGames: { status: log.status, games, source: log.source, retrieved_at: log.retrieved_at, error: log.error || null },
    usage: summarizeUsage(log.games, scoring),
    upcomingGame: game,
    opponentDefense,
    unavailableData: {
      snapShare: "Snap counts are not available from BetEdge's current data feeds.",
      redZone: "Red-zone touches are not broken out in the current feeds; touchdowns are the closest proxy.",
    },
  };
}

// ---- Team context (injury impact / waiver) --------------------------------

export async function getTeamContext(teamInput, { forceRefresh = false } = {}) {
  const team = await resolveTeam(teamInput);
  if (!team) return { status: "unavailable", error: `Unknown team: ${teamInput}` };
  const [depth, injuries, roster] = await Promise.all([
    getDepthChart(team, { forceRefresh }),
    getTeamInjuryReports(SPORT, [team.name], { forceRefresh }).catch(() => ({})),
    getTeamRoster(team).then((m) => m.value).catch(() => []),
  ]);
  const report = injuries[team.name];
  const withStatus = {};
  for (const [pos, names] of Object.entries(depth.chart || {})) {
    withStatus[pos] = names.slice(0, 4).map((n) => {
      const p = roster.find((r) => norm(r.name) === norm(n)) || { name: n };
      const s = playerInjuryStatus(p, report);
      return { name: n, status: s.label, confirmed: s.confirmed, injury: s.injury, updated_at: s.updated_at };
    });
  }
  return {
    status: "ok",
    team: team.name,
    depthChart: { status: depth.status, positions: withStatus, source: depth.source, retrieved_at: depth.retrieved_at, error: depth.error || null },
    injuryReport: report
      ? { status: report.status, source: report.source, source_url: report.source_url, retrieved_at: report.retrieved_at, last_updated: report.last_updated, players: report.players, conflicts: report.conflicts, note: report.note }
      : { status: "unavailable" },
    upcomingGame: await getUpcomingGame(team.name),
  };
}

// Waiver opportunities: fantasy starters listed Out/Doubtful/IR league-wide,
// and who is next on the depth chart behind them.
const OUT_LIKE = /^(out|doubtful|injured reserve|ir|pup|suspended|reserve)/i;

export async function getOpportunityReport({ position = "ALL", forceRefresh = false } = {}) {
  const teams = await getEspnTeams();
  const reports = await getTeamInjuryReports(SPORT, teams.map((t) => t.name), { forceRefresh });
  const wanted = String(position).toUpperCase();
  const positions = wanted === "ALL" ? ["QB", "RB", "WR", "TE"] : [wanted];
  const affectedTeams = teams.filter((t) =>
    (reports[t.name]?.players || []).some((p) => OUT_LIKE.test(p.gameDesignation || "") && positions.includes(p.position === "HB" ? "RB" : p.position))
  );
  const charts = await Promise.all(affectedTeams.map((t) => getDepthChart(t)));
  const opportunities = [];
  affectedTeams.forEach((t, i) => {
    const chart = charts[i].chart || {};
    const out = (reports[t.name]?.players || []).filter((p) => OUT_LIKE.test(p.gameDesignation || ""));
    for (const pos of positions) {
      const list = chart[pos] || [];
      const outNames = new Set(out.map((p) => norm(p.name)));
      const starters = list.slice(0, pos === "WR" ? 3 : 1);
      const injuredStarters = starters.filter((n) => outNames.has(norm(n)));
      if (!injuredStarters.length) continue;
      const nextUp = list.filter((n) => !outNames.has(norm(n))).slice(0, 2);
      opportunities.push({
        team: t.name,
        position: pos,
        injuredStarters: injuredStarters.map((n) => {
          const e = out.find((p) => norm(p.name) === norm(n));
          return { name: n, designation: e?.gameDesignation || null, injury: e?.injury || null, updated: e?.updated || null };
        }),
        nextUp,
        depthChartStatus: charts[i].status,
      });
    }
  });
  const unavailableTeams = teams.filter((t) => reports[t.name]?.status !== "ok").map((t) => t.name);
  return {
    status: "ok",
    position: wanted,
    opportunities,
    note: "Built from current injury reports + depth charts. This does not know who is available in your league — pair it with your league's waiver list or a screenshot.",
    injuryReportsUnavailableFor: unavailableTeams,
    retrieved_at: new Date().toISOString(),
  };
}

// Autocomplete: best-matching current NFL players for a partial name.
const SEARCH_POSITIONS = new Set(["QB", "RB", "WR", "TE", "PK", "K", "FB"]);
export async function searchPlayers(q, { limit = 8 } = {}) {
  const query = norm(q);
  if (query.length < 2) return [];
  const { players } = await getPlayerIndex();
  const words = query.split(" ");
  const scored = [];
  for (const p of players) {
    if (!SEARCH_POSITIONS.has(p.position)) continue;
    const pn = norm(p.name);
    let score = 0;
    if (pn === query) score = 100;
    else if (pn.startsWith(query)) score = 80;
    else if (lastName(p.name).startsWith(query)) score = 70;
    else if (words.every((w) => pn.split(" ").some((part) => part.startsWith(w)))) score = 60;
    else if (pn.includes(query)) score = 40;
    if (score) scored.push({ p, score });
  }
  scored.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name));
  return scored.slice(0, limit).map(({ p }) => ({ name: p.name, team: p.teamAbbr, teamName: p.team, position: p.position === "PK" ? "K" : p.position }));
}
