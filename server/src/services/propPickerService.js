// Prop Hunter — the fourth built-in picker. Picks DraftKings player props
// (NFL, NBA) where DraftKings pays more than the other books' no-vig fair
// price, using the same edge math as Props Edge (propsService.normalizeProps).
// Grades from ESPN box scores after the game, so its record is automatic.
import { normalizePlayerName } from "./injuryService.js";

export const PROPS = "Prop Hunter";

const MIN_EV = Number(process.env.PROP_PICKER_MIN_EV || 3);    // % expected value at DraftKings' price
const MIN_FAIR_BOOKS = 2;                                        // other books posting the same line
const PRICE_RANGE = [-200, 200];                                 // skip heavy juice and long shots
// Markets Prop Hunter bets (and knows how to grade). Anytime TD is left out:
// it has no Under side, so there's no clean fair price to measure against.
export const GRADEABLE = new Set([
  "player_pass_yds", "player_pass_tds", "player_rush_yds", "player_reception_yds", "player_receptions",
  "player_points", "player_rebounds", "player_assists", "player_threes", "player_points_rebounds_assists",
]);

const norm = normalizePlayerName;
const fmtOdds = (o) => (o > 0 ? `+${o}` : String(o));
const fairAmerican = (p) => (p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100));

function isRuledOut(player, injuries) {
  const n = norm(player);
  for (const side of [injuries?.homeTeam, injuries?.awayTeam]) {
    for (const p of side?.players || []) {
      if (norm(p.name) !== n) continue;
      const d = String(p.gameDesignation || "").toLowerCase();
      if (/^(out|doubtful|injured reserve|ir|suspended|inactive|pup)/.test(d)) return p.gameDesignation;
    }
  }
  return null;
}

/**
 * Best Prop Hunter candidate for one game, or null.
 * props: normalizeProps() output; injuries: getMatchupInjuries() output (optional).
 */
export function propPick(sport, g, props, injuries) {
  const rows = (props?.props || []).filter((p) =>
    p.kind === "ou" && GRADEABLE.has(p.market) && p.best && p.best.ev != null && p.best.ev >= MIN_EV && (p.fairBooks || 0) >= MIN_FAIR_BOOKS);
  const options = [];
  for (const p of rows) {
    const price = p.best.side === "Over" ? p.over : p.under;
    if (price == null || price < PRICE_RANGE[0] || price > PRICE_RANGE[1]) continue;
    if (isRuledOut(p.player, injuries)) continue;
    options.push({ p, price });
  }
  if (!options.length) return null;
  options.sort((a, b) => b.p.best.ev - a.p.best.ev);
  const { p, price } = options[0];
  const side = p.best.side;
  const fair = side === "Over" ? p.fair.over : p.fair.under;
  const ev = p.best.ev;
  const bet = `${p.player} ${side} ${p.line} ${p.marketLabel}`;
  const lineNote = p.consensusLine != null && p.consensusLine !== p.line
    ? ` The other books' median line is ${p.consensusLine}, so DraftKings' ${p.line} is ${(side === "Over") === (p.consensusLine > p.line) ? "the better number" : "a tougher number"}.`
    : "";
  return {
    picker: PROPS,
    market: "player_prop",
    bet,
    odds: price,
    strength: ev / MIN_EV,
    confidence: ev >= 8 ? "High" : ev >= 5 ? "Medium" : "Low",
    reason: `DraftKings has ${side} ${p.line} at ${fmtOdds(price)}. With the vig removed, ${p.fairBooks} other books posting the same line make the ${side} ${fair}% likely (fair ${fmtOdds(fairAmerican(fair / 100))}), so DraftKings' price is worth about +${ev.toFixed(1)}% in expected value.${lineNote}`,
    prop: { player: p.player, market: p.market, marketLabel: p.marketLabel, side, line: p.line, book: "DraftKings" },
  };
}

// ---- Grading from ESPN box scores --------------------------------------------

const ESPN = { nfl: "football/nfl", nba: "basketball/nba" };
let espnFetch = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", Accept: "application/json", Referer: "https://www.espn.com/" } });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${url}`);
  return res.json();
};
export function __setEspnFetch(fn) { espnFetch = fn; }

const teamKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
const nickname = (s) => teamKey(s).split(" ").slice(-1)[0];
function sameTeam(a, b) {
  return teamKey(a) === teamKey(b) || (nickname(a) && nickname(a) === nickname(b));
}

// ESPN's scoreboard dates are US Eastern calendar days.
function etDay(iso, offsetDays = 0) {
  const d = new Date(Date.parse(iso) + offsetDays * 86400e3);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d).replace(/-/g, "");
}

/** Find the ESPN event id for a game (away @ home, kickoff). */
export async function findEspnEvent(sport, homeTeam, awayTeam, kickoffIso) {
  const path = ESPN[sport];
  if (!path) return null;
  for (const off of [0, -1, 1]) {
    const sb = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard?dates=${etDay(kickoffIso, off)}`);
    for (const ev of sb?.events || []) {
      const comps = ev.competitions?.[0]?.competitors || [];
      const home = comps.find((c) => c.homeAway === "home")?.team?.displayName;
      const away = comps.find((c) => c.homeAway === "away")?.team?.displayName;
      if (home && away && sameTeam(home, homeTeam) && sameTeam(away, awayTeam)) {
        return { id: ev.id, completed: !!ev.status?.type?.completed, state: ev.status?.type?.state || null };
      }
    }
  }
  return null;
}

// Pull the stat a market is graded on out of an ESPN box score.
// Returns { status: "ok", value } | { status: "dnp" } | { status: "missing" }.
export function statFromBox(sport, market, player, summary) {
  const n = norm(player);
  const teams = summary?.boxscore?.players || [];
  const get = (cat, key) => {
    const i = (cat.keys || []).indexOf(key);
    return i;
  };
  if (sport === "nba") {
    for (const t of teams) {
      for (const cat of t.statistics || []) {
        const a = (cat.athletes || []).find((x) => norm(x.athlete?.displayName) === n);
        if (!a) continue;
        if (a.didNotPlay || !Array.isArray(a.stats) || !a.stats.length) return { status: "dnp" };
        const v = (key) => {
          const i = get(cat, key);
          if (i < 0) return null;
          const raw = String(a.stats[i] ?? "");
          const num = Number(raw.split("-")[0]); // "3-7" made-attempted -> made
          return Number.isFinite(num) ? num : null;
        };
        const pts = v("points"), reb = v("rebounds"), ast = v("assists");
        const threes = v("threePointFieldGoalsMade-threePointFieldGoalsAttempted");
        const map = {
          player_points: pts, player_rebounds: reb, player_assists: ast, player_threes: threes,
          player_points_rebounds_assists: pts != null && reb != null && ast != null ? pts + reb + ast : null,
        };
        const value = map[market];
        return value == null ? { status: "missing" } : { status: "ok", value };
      }
    }
    return { status: "missing" };
  }
  if (sport === "nfl") {
    const spec = {
      player_pass_yds: ["passing", "passingYards"],
      player_pass_tds: ["passing", "passingTouchdowns"],
      player_rush_yds: ["rushing", "rushingYards"],
      player_reception_yds: ["receiving", "receivingYards"],
      player_receptions: ["receiving", "receptions"],
    }[market];
    if (!spec) return { status: "missing" };
    let seenAnywhere = false;
    for (const t of teams) {
      for (const cat of t.statistics || []) {
        const a = (cat.athletes || []).find((x) => norm(x.athlete?.displayName) === n);
        if (!a) continue;
        seenAnywhere = true;
        if (cat.name !== spec[0]) continue;
        const i = get(cat, spec[1]);
        const num = i < 0 ? null : Number(String(a.stats?.[i] ?? "").replace(/,/g, ""));
        return Number.isFinite(num) ? { status: "ok", value: num } : { status: "missing" };
      }
    }
    // ESPN only lists a player in categories he recorded a stat in. If he shows
    // up elsewhere in the box score (played, but no catches), that stat is 0.
    // If he's nowhere, we can't tell "0" from "didn't play", so leave it.
    return seenAnywhere ? { status: "ok", value: 0 } : { status: "missing" };
  }
  return { status: "missing" };
}

export function gradeProp(prop, value) {
  const line = Number(prop.line);
  if (!Number.isFinite(line) || !Number.isFinite(value)) return null;
  if (value === line) return "push";
  return (value > line) === (prop.side === "Over") ? "win" : "loss";
}

/**
 * Grade one Prop Hunter pick. Returns { result, value?, note } or
 * { result: null, note } when it can't be graded yet.
 */
export async function gradePropPick(pick) {
  const prop = typeof pick.prop === "string" ? JSON.parse(pick.prop) : pick.prop;
  if (!prop) return { result: null, note: "no prop details" };
  const [away, home] = String(pick.game).split(" @ ");
  const ev = await findEspnEvent(pick.sport, home, away, new Date(pick.kickoff_at).toISOString());
  if (!ev) return { result: null, note: "ESPN game not found" };
  if (!ev.completed) return { result: null, note: "game not final on ESPN yet" };
  const summary = await espnFetch(`https://site.api.espn.com/apis/site/v2/sports/${ESPN[pick.sport]}/summary?event=${ev.id}`);
  const s = statFromBox(pick.sport, prop.market, prop.player, summary);
  if (s.status === "dnp") return { result: "void", note: `${prop.player} did not play` };
  if (s.status !== "ok") return { result: null, note: `${prop.player} not found in the box score` };
  return { result: gradeProp(prop, s.value), value: s.value, note: `${prop.player}: ${s.value} ${prop.marketLabel}` };
}

/** Closing price: DraftKings' price on the same side and line in the last pregame props pull. */
export function propClosingOdds(pick, snapshot) {
  const prop = typeof pick.prop === "string" ? JSON.parse(pick.prop) : pick.prop;
  if (!prop || !snapshot?.data?.props) return null;
  if (Date.parse(snapshot.fetchedAt) <= Date.parse(pick.created_at)) return null; // no newer pull than the pick
  if (Date.parse(snapshot.fetchedAt) >= Date.parse(pick.kickoff_at)) return null;
  const row = snapshot.data.props.find((p) => p.market === prop.market && norm(p.player) === norm(prop.player));
  if (!row || Number(row.line) !== Number(prop.line)) return null;
  const price = prop.side === "Over" ? row.over : row.under;
  return Number.isInteger(price) && Math.abs(price) >= 100 ? price : null;
}
