import { cachedWithMeta, invalidate } from "./cache.js";
import { getLeagueInjuries, espnInjuryPageUrl, isEspnSupported } from "./espnService.js";
import { getInjuries as getSdioInjuries } from "./statsService.js";
import { toTeamCode } from "../data/teamCodes.js";

// ---------------------------------------------------------------------------
// Matchup injury reports — BOTH teams, every time, with freshness metadata.
//
// Rules this module enforces (they exist because of real bugs):
//   1. Both teams are always looked up, and each team carries its own
//      `status`. One team failing never silently hides the other, and a
//      failed lookup is "unavailable", never an empty (= "healthy") list.
//   2. Every team report carries source / source_url / retrieved_at /
//      published_at / last_updated so the UI and the AI can say how old it is.
//   3. A player who isn't on a report is NOT confirmed healthy — the report
//      says so explicitly (`absenceMeansHealthy: false`) so downstream
//      consumers (the chat prompt especially) can't make that inference.
//   4. When two sources disagree about a player, both versions are kept in
//      `conflicts` instead of picking one and inventing certainty.
// ---------------------------------------------------------------------------

// How long a fetched injury report is served from cache before we go back
// upstream. Injury news moves fast on practice days, so keep this short.
const INJURY_CACHE_TTL_SECONDS = Number(process.env.INJURY_CACHE_TTL_SECONDS || 600); // 10 min

// How old injury data may be before the chat must refresh it before
// answering an injury/status question.
export const INJURY_FRESHNESS_MINUTES = Number(process.env.INJURY_FRESHNESS_MINUTES || 15);

const SDIO_SOURCE_URL = "https://sportsdata.io/developers/api-documentation";

function normName(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function nickname(fullName) {
  const parts = normName(fullName).split(" ");
  return parts[parts.length - 1] || "";
}

function maxIso(dates) {
  const ts = dates
    .map((d) => (d ? Date.parse(d) : NaN))
    .filter((n) => Number.isFinite(n));
  return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
}

function titleCase(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Practice participation, pulled from the report text. Only returns a value
// when the text actually says it — never guessed.
function parsePracticeStatus(...texts) {
  const t = texts.filter(Boolean).join(" ").toLowerCase();
  if (!t) return null;
  if (/did not practice|did not participate|\bdnp\b|sat out|held out of practice|missed (wednesday|thursday|friday|tuesday|monday|saturday)'?s? practice/.test(t)) {
    return "Did not practice";
  }
  if (/limited (participant|practice|in practice)|was limited|\blimited\b/.test(t)) return "Limited";
  if (/full participant|full practice|fully participated|practiced fully|full go/.test(t)) return "Full";
  return null;
}

// ESPN designations → the standard NFL game designations where possible.
function espnDesignation(entry) {
  if (typeof entry.status === "string" && entry.status) return entry.status;
  const fromType = entry.type?.description || entry.type?.abbreviation;
  if (fromType) return titleCase(fromType);
  const fantasy = entry.details?.fantasyStatus?.description;
  if (fantasy) return titleCase(fantasy);
  return null;
}

function normalizeEspnEntry(e) {
  const a = e.athlete || {};
  const d = e.details || {};
  const injuryParts = [d.side && d.side !== "Not Specified" ? d.side : null, d.type, d.detail && d.detail !== "Not Specified" ? d.detail : null].filter(Boolean);
  return {
    name: a.displayName || [a.firstName, a.lastName].filter(Boolean).join(" ") || null,
    position: a.position?.abbreviation || a.position?.displayName || null,
    injury: injuryParts.length ? injuryParts.join(" ") : null,
    practiceStatus: parsePracticeStatus(e.shortComment, e.longComment),
    gameDesignation: espnDesignation(e),
    returnDate: d.returnDate || null,
    note: e.shortComment || null,
    updated: e.date || null,
    source: "ESPN",
  };
}

function normalizeSdioEntry(i) {
  const practice = i.PracticeDescription || i.Practice || null;
  return {
    name: i.Name || [i.FirstName, i.LastName].filter(Boolean).join(" ") || null,
    position: i.Position || null,
    injury: i.BodyPart || i.InjuryBodyPart || null,
    practiceStatus: practice ? parsePracticeStatus(practice) || practice : parsePracticeStatus(i.InjuryNotes),
    // "Status" on SportsData.io Player objects is roster status (Active /
    // Inactive), not a game designation — prefer the injury-specific fields.
    gameDesignation: i.InjuryStatus || (i.DeclaredInactive ? "Inactive" : null) || i.Status || null,
    returnDate: null,
    note: i.InjuryNotes || null,
    updated: i.Updated || i.InjuryStartDate || null,
    source: "SportsDataIO",
  };
}

async function espnLeague(sport, forceRefresh) {
  const key = `espn-injuries:${sport}`;
  if (forceRefresh) invalidate(key);
  return cachedWithMeta(key, () => getLeagueInjuries(sport), INJURY_CACHE_TTL_SECONDS);
}

async function sdioLeague(sport, forceRefresh) {
  const key = `sdio-injuries-meta:${sport}`;
  if (forceRefresh) {
    invalidate(key);
    invalidate(`injuries:${sport}`); // statsService's own cache key
  }
  return cachedWithMeta(key, () => getSdioInjuries(sport), INJURY_CACHE_TTL_SECONDS);
}

function findEspnTeamGroup(data, teamFullName) {
  const groups = data?.injuries || [];
  const target = normName(teamFullName);
  let g = groups.find((x) => normName(x.displayName) === target);
  if (!g) {
    // "LA Clippers" vs "Los Angeles Clippers" etc. — nickname is unique per league.
    const nick = nickname(teamFullName);
    g = groups.find((x) => nick && nickname(x.displayName) === nick);
  }
  return g || null;
}

function emptyReport(sport, teamFullName) {
  return {
    team: teamFullName,
    teamCode: toTeamCode(sport, teamFullName),
    status: "unavailable",
    players: [],
    source: null,
    source_url: null,
    retrieved_at: null,
    published_at: null,
    last_updated: null,
    conflicts: [],
    // Never let an empty list read as "everyone is healthy".
    absenceMeansHealthy: false,
    note: null,
    errors: [],
  };
}

function detectConflicts(primary, secondary) {
  const conflicts = [];
  const byName = new Map(secondary.map((p) => [normName(p.name), p]));
  for (const p of primary) {
    const other = byName.get(normName(p.name));
    if (!other) continue;
    const a = normName(p.gameDesignation);
    const b = normName(other.gameDesignation);
    // Roster-status noise ("active") from the secondary feed isn't a real disagreement.
    if (a && b && a !== b && b !== "active") {
      conflicts.push({
        player: p.name,
        reports: [
          { source: p.source, gameDesignation: p.gameDesignation, practiceStatus: p.practiceStatus, updated: p.updated },
          { source: other.source, gameDesignation: other.gameDesignation, practiceStatus: other.practiceStatus, updated: other.updated },
        ],
      });
    }
  }
  return conflicts;
}

async function buildTeamReport(sport, teamFullName, espnRes, sdioRes) {
  const report = emptyReport(sport, teamFullName);
  const teamCode = report.teamCode;

  let espnPlayers = null;
  if (espnRes?.ok) {
    const group = findEspnTeamGroup(espnRes.meta.value, teamFullName);
    // A successful league-wide pull that doesn't list this team means ESPN
    // has no injuries on file for it — a real, sourced "none listed", which
    // is different from "we couldn't check".
    espnPlayers = (group?.injuries || []).map(normalizeEspnEntry);
  } else if (espnRes && !espnRes.ok) {
    report.errors.push(`ESPN: ${espnRes.error}`);
  }

  let sdioPlayers = null;
  if (sdioRes?.ok) {
    const list = Array.isArray(sdioRes.meta.value) ? sdioRes.meta.value : [];
    sdioPlayers = list.filter((i) => i.Team === teamCode).map(normalizeSdioEntry);
  } else if (sdioRes && !sdioRes.ok) {
    report.errors.push(`SportsDataIO: ${sdioRes.error}`);
  }

  if (espnPlayers) {
    report.status = "ok";
    report.players = espnPlayers;
    report.source = "ESPN";
    report.source_url = espnInjuryPageUrl(sport, teamFullName);
    report.retrieved_at = espnRes.meta.retrievedAt;
    report.published_at = espnRes.meta.value.timestamp || null;
    report.last_updated = maxIso(espnPlayers.map((p) => p.updated)) || report.published_at;
    if (sdioPlayers) report.conflicts = detectConflicts(espnPlayers, sdioPlayers);
  } else if (sdioPlayers) {
    report.status = "ok";
    report.players = sdioPlayers;
    report.source = "SportsDataIO";
    report.source_url = SDIO_SOURCE_URL;
    report.retrieved_at = sdioRes.meta.retrievedAt;
    report.published_at = null;
    report.last_updated = maxIso(sdioPlayers.map((p) => p.updated));
  }

  if (report.status === "ok" && report.players.length === 0) {
    report.note = `No players listed on the ${report.source} report. That is not confirmation every player is healthy or active.`;
  } else if (report.status === "unavailable") {
    report.note = "Current injury status unavailable — the injury report could not be retrieved. Do not treat this as 'no injuries'.";
  }
  return report;
}

async function settle(promise) {
  try {
    return { ok: true, meta: await promise };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Injury reports for both teams in a matchup.
 * Returns { homeTeam, awayTeam, retrieved_at, freshnessMinutes } where each
 * side is a team report (see emptyReport for the shape).
 */
export async function getMatchupInjuries(sport, homeTeamFullName, awayTeamFullName, { forceRefresh = false } = {}) {
  // Both upstream feeds are league-wide, so one call each covers both teams —
  // but results are split and checked per team so neither side can vanish.
  const [espnRes, sdioRes] = await Promise.all([
    isEspnSupported(sport) ? settle(espnLeague(sport, forceRefresh)) : Promise.resolve(null),
    settle(sdioLeague(sport, forceRefresh)),
  ]);

  const [homeTeam, awayTeam] = await Promise.all([
    buildTeamReport(sport, homeTeamFullName, espnRes, sdioRes),
    buildTeamReport(sport, awayTeamFullName, espnRes, sdioRes),
  ]);

  for (const [side, r] of [["home", homeTeam], ["away", awayTeam]]) {
    if (r.status !== "ok") {
      console.error(`getMatchupInjuries(${sport}): ${side} team "${r.team}" (${r.teamCode}) unavailable — ${r.errors.join("; ")}`);
    }
  }

  return {
    homeTeam,
    awayTeam,
    retrieved_at: maxIso([homeTeam.retrieved_at, awayTeam.retrieved_at]),
    freshnessMinutes: INJURY_FRESHNESS_MINUTES,
  };
}

// Minutes since a team report (or whole matchup report) was retrieved.
export function ageMinutes(iso) {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (Date.now() - t) / 60000 : null;
}

// True when this injury data can't be trusted for a status answer without a refresh.
export function injuriesNeedRefresh(injuries) {
  if (!injuries || !injuries.homeTeam || !injuries.awayTeam) return true;
  for (const r of [injuries.homeTeam, injuries.awayTeam]) {
    if (r.status !== "ok") return true;
    const age = ageMinutes(r.retrieved_at);
    if (age === null || age > INJURY_FRESHNESS_MINUTES) return true;
  }
  return false;
}

/**
 * Injury reports for any list of teams (Fantasy Edge needs single teams and
 * league-wide sweeps, not just matchups). Same rules as getMatchupInjuries:
 * each team carries its own status, and a failed lookup is "unavailable".
 * Returns { [teamFullName]: report }.
 */
export async function getTeamInjuryReports(sport, teamFullNames, { forceRefresh = false } = {}) {
  const [espnRes, sdioRes] = await Promise.all([
    isEspnSupported(sport) ? settle(espnLeague(sport, forceRefresh)) : Promise.resolve(null),
    settle(sdioLeague(sport, forceRefresh)),
  ]);
  const unique = [...new Set(teamFullNames.filter(Boolean))];
  const reports = await Promise.all(unique.map((t) => buildTeamReport(sport, t, espnRes, sdioRes)));
  return Object.fromEntries(unique.map((t, i) => [t, reports[i]]));
}

export { normName as normalizePlayerName };
