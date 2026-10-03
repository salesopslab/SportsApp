// The three built-in BetEdge pickers. Each one is a plain, explainable rule
// set over data BetEdge already collects, so every pick's reason can be
// checked against the game page:
//   - Line Movement Picker: follows a significant line move close to kickoff.
//   - Matchup Stats Picker: power ratings from season point differential vs
//     the market spread (MLB: run differential vs the moneyline).
//   - Value Contrarian Picker: shops every book for an underdog / under
//     priced better than the market's own no-vig fair odds.
// runPickers() posts picks on games starting soon (one per picker per game,
// with daily caps) and grades finished picks from final scores.
import { pool, ensureSchema } from "../db.js";
import { getOddsForSport, getScoresForSport, SPORT_KEYS } from "./oddsService.js";
import { getLineHistory } from "./snapshotService.js";
import { impliedProb, noVig } from "./picksService.js";
import { savePick, gradePick } from "./ledgerService.js";
import { cached } from "./cache.js";

export const LINE = "Line Movement Picker";
export const STATS = "Matchup Stats Picker";
export const VALUE = "Value Contrarian Picker";
const SPORTS = Object.keys(SPORT_KEYS);
// Rough regular season + playoffs, [startMonth, startDay, endMonth, endDay]
// (months 1-12). Out-of-season sports are skipped so scheduled runs don't
// spend Odds API credits on empty slates.
const SEASONS = { nfl: [8, 25, 2, 15], ncaaf: [8, 20, 1, 25], nba: [10, 15, 6, 25], ncaab: [11, 1, 4, 10], mlb: [3, 15, 11, 10] };
export function inSeason(sport, d = new Date()) {
  const s = SEASONS[sport];
  if (!s) return true;
  const md = (d.getUTCMonth() + 1) * 100 + d.getUTCDate(), start = s[0] * 100 + s[1], end = s[2] * 100 + s[3];
  return start <= end ? md >= start && md <= end : md >= start || md <= end;
}

// Runs once a day (about 8 AM Pacific): each run covers every game starting
// in the next 24 hours and grades everything that has finished.
const WINDOW = { [LINE]: [0.5, 24], [STATS]: [0.5, 24], [VALUE]: [0.5, 24] };
export const DAILY_HOUR = Number(process.env.PICKERS_DAILY_HOUR || 8); // Pacific
const DAILY_CAP = 8;       // per picker, per Pacific day (by posting time)
const DAILY_SPORT_CAP = 4; // per picker, per sport, per day
const GRADE_AFTER_HOURS = 2.5; // start checking for a final this long after kickoff
const VOID_AFTER_DAYS = 4;     // no final score after this long => void (postponed/cancelled)

// ---- Bets: text format + grading ---------------------------------------
const fmtPoint = (p) => (Number(p) === 0 ? "PK" : `${p > 0 ? "+" : ""}${p}`);
export const betText = {
  spread: (team, point) => `${team} ${fmtPoint(point)}`,
  moneyline: (team) => `${team} ML`,
  total: (side, point) => `${side} ${point}`,
};
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// "Denver Broncos +3" | "Denver Broncos PK" | "Denver Broncos ML" | "Over 42.5"
export function parseBet(bet, homeTeam, awayTeam) {
  const b = String(bet || "").trim();
  let m = b.match(/^(over|under)\s+(\d+(?:\.\d+)?)$/i);
  if (m) return { market: "total", side: m[1][0].toUpperCase() + m[1].slice(1).toLowerCase(), point: Number(m[2]) };
  const whichTeam = (name) => {
    const n = norm(name);
    if (n === norm(homeTeam)) return "home";
    if (n === norm(awayTeam)) return "away";
    // Tolerate a nickname-only or city-only bet ("Broncos +3").
    const h = norm(homeTeam).split(" "), a = norm(awayTeam).split(" "), w = n.split(" ");
    const hh = w.every((x) => h.includes(x)), aa = w.every((x) => a.includes(x));
    return hh && !aa ? "home" : aa && !hh ? "away" : null;
  };
  m = b.match(/^(.+?)\s+ML$/i);
  if (m) { const s = whichTeam(m[1]); return s ? { market: "moneyline", side: s, team: m[1] } : null; }
  m = b.match(/^(.+?)\s+(PK|[+-]\d+(?:\.\d+)?)$/i);
  if (m) { const s = whichTeam(m[1]); return s ? { market: "spread", side: s, team: m[1], point: /pk/i.test(m[2]) ? 0 : Number(m[2]) } : null; }
  return null;
}

export function gradeBet(parsed, homeScore, awayScore) {
  const h = Number(homeScore), a = Number(awayScore);
  if (!parsed || !Number.isFinite(h) || !Number.isFinite(a)) return null;
  if (parsed.market === "total") {
    const t = h + a;
    if (t === parsed.point) return "push";
    return (t > parsed.point) === (parsed.side === "Over") ? "win" : "loss";
  }
  const mine = parsed.side === "home" ? h : a, theirs = parsed.side === "home" ? a : h;
  if (parsed.market === "moneyline") return mine > theirs ? "win" : mine < theirs ? "loss" : "push";
  const adj = mine + parsed.point - theirs;
  return adj > 0 ? "win" : adj < 0 ? "loss" : "push";
}

// ---- Shared helpers -----------------------------------------------------
const outcome = (list, name) => (list || []).find((o) => o.name === name) || null;
const hours = (h) => h * 3600e3;
const round1 = (n) => Math.round(n * 10) / 10;
const americanToDecimal = (o) => (o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o));
const pct = (p) => `${(p * 100).toFixed(1)}%`;
const fmtOdds = (o) => (o > 0 ? `+${o}` : String(o));
const nick = (team) => String(team).split(" ").slice(-1)[0];

// ---- 1) Line Movement Picker ---------------------------------------------
const LM_SPREAD_MOVE = { nfl: 1, ncaaf: 1.5, nba: 1.5, ncaab: 1.5 };
const LM_TOTAL_MOVE = { nfl: 1.5, ncaaf: 2, nba: 2.5, ncaab: 2.5, mlb: 0.5 };
const LM_ML_MOVE = 0.04; // 4 points of implied probability (MLB and spread-less games)
const KEY_NUMBERS = { nfl: [3, 7], ncaaf: [3, 7] };

// Did the line move onto, off of, or through a key number (3, 7 in football)?
export function crossedKey(sport, a, b) {
  const lo = Math.min(Math.abs(a), Math.abs(b)), hi = Math.max(Math.abs(a), Math.abs(b));
  if (lo === hi) return false;
  return (KEY_NUMBERS[sport] || []).some((k) => (lo < k && hi >= k) || (lo <= k && hi > k));
}

// history: getLineHistory() result. Returns a candidate pick or null.
export function lineMovementPick(sport, g, history) {
  if (!history?.hasHistory || !Array.isArray(history.summary)) return null;
  const enough = (m) => (m.dataPoints || 0) >= 3 && Date.parse(m.lastSeen) - Date.parse(m.firstSeen) >= hours(3);
  const options = [];
  // Spread: follow the home line's move.
  const hs = history.summary.find((m) => m.market === "spread" && m.side === g.homeTeam);
  const minSpread = LM_SPREAD_MOVE[sport];
  if (hs && minSpread && enough(hs) && hs.openPoint != null && hs.currentPoint != null) {
    const delta = hs.currentPoint - hs.openPoint; // more negative = money on home
    const key = crossedKey(sport, hs.openPoint, hs.currentPoint);
    if (Math.abs(delta) >= minSpread || (key && Math.abs(delta) >= 0.5)) {
      const team = delta < 0 ? g.homeTeam : g.awayTeam;
      const cur = outcome(g.spread, team);
      if (cur?.price != null && cur.point != null) {
        const strength = Math.abs(delta) / minSpread + (key ? 1 : 0);
        const fromTo = `${nick(g.homeTeam)} ${fmtPoint(hs.openPoint)} → ${fmtPoint(hs.currentPoint)}`;
        options.push({
          market: "spread", bet: betText.spread(team, cur.point), odds: cur.price, strength,
          reason: `The spread moved ${fromTo} since it opened (${Math.abs(delta)} pts${key ? ", through a key number" : ""}). Following the move toward ${team}.`,
        });
      }
    }
  }
  // Total: follow the direction of the move.
  const ov = history.summary.find((m) => m.market === "total" && m.side === "Over");
  const minTotal = LM_TOTAL_MOVE[sport];
  if (ov && minTotal && enough(ov) && ov.openPoint != null && ov.currentPoint != null) {
    const delta = ov.currentPoint - ov.openPoint;
    if (Math.abs(delta) >= minTotal) {
      const side = delta > 0 ? "Over" : "Under";
      const cur = outcome(g.total, side);
      if (cur?.price != null && cur.point != null) {
        options.push({
          market: "total", bet: betText.total(side, cur.point), odds: cur.price, strength: Math.abs(delta) / minTotal,
          reason: `The total moved ${ov.openPoint} → ${ov.currentPoint} since it opened (${round1(Math.abs(delta))} pts). Following the move to the ${side.toLowerCase()}.`,
        });
      }
    }
  }
  // Moneyline: MLB, or any game with no spread posted.
  if (sport === "mlb" || !(g.spread || []).length) {
    const hm = history.summary.find((m) => m.market === "moneyline" && m.side === g.homeTeam);
    if (hm && enough(hm) && hm.openPrice != null && hm.currentPrice != null) {
      const d = impliedProb(hm.currentPrice) - impliedProb(hm.openPrice);
      if (Math.abs(d) >= LM_ML_MOVE) {
        const team = d > 0 ? g.homeTeam : g.awayTeam;
        const cur = outcome(g.moneyline, team);
        if (cur?.price != null) {
          options.push({
            market: "moneyline", bet: betText.moneyline(team), odds: cur.price, strength: Math.abs(d) / LM_ML_MOVE,
            reason: `${nick(g.homeTeam)} moneyline moved ${fmtOdds(hm.openPrice)} → ${fmtOdds(hm.currentPrice)} (${(Math.abs(d) * 100).toFixed(1)} pts of implied probability). Following the money to ${team}.`,
          });
        }
      }
    }
  }
  if (!options.length) return null;
  const best = options.sort((a, b) => b.strength - a.strength)[0];
  return { picker: LINE, ...best, confidence: best.strength >= 2 ? "High" : best.strength >= 1.5 ? "Medium" : "Low" };
}

// ---- 2) Matchup Stats Picker ---------------------------------------------
// Pro leagues only: in college, season point differential is dominated by
// who you happened to play (FCS blowouts), so without a strength-of-schedule
// model it would mislead. maxEdge: a gap this big vs the market is far more
// likely missing information (injury, QB change) than a real edge — pass.
const STATS_CFG = {
  nfl: { minGames: 3, shrink: 4, hfa: 1.5, edge: 2.5, maxEdge: 8 },
  nba: { minGames: 8, shrink: 10, hfa: 2, edge: 3, maxEdge: 9 },
  mlb: { minGames: 20, shrink: 30, hfaProb: 0.035, edge: 0.05, maxEdge: 0.15 },
};

// ratings: { [normalized team name]: { games, pf, pa } } from season standings.
export function findTeam(ratings, team) {
  if (!ratings) return null;
  const n = norm(team);
  if (ratings[n]) return ratings[n];
  // Fall back to a unique "starts with" match (odds feeds sometimes add/drop a mascot).
  const keys = Object.keys(ratings).filter((k) => k.startsWith(n) || n.startsWith(k));
  return keys.length === 1 ? ratings[keys[0]] : null;
}

export function statsPick(sport, g, ratings) {
  const cfg = STATS_CFG[sport];
  const H = findTeam(ratings, g.homeTeam), A = findTeam(ratings, g.awayTeam);
  if (!cfg || !H || !A || H.games < cfg.minGames || A.games < cfg.minGames) return null;

  if (sport === "mlb") {
    const pyth = (t) => Math.pow(t.pf, 1.83) / (Math.pow(t.pf, 1.83) + Math.pow(t.pa, 1.83));
    const shrunk = (t) => 0.5 + (pyth(t) - 0.5) * (t.games / (t.games + cfg.shrink));
    const ph = shrunk(H), pa = shrunk(A);
    let pHome = (ph * (1 - pa)) / (ph * (1 - pa) + pa * (1 - ph)) + cfg.hfaProb; // log5 + home field
    pHome = Math.min(0.85, Math.max(0.15, pHome));
    const mh = outcome(g.moneyline, g.homeTeam), ma = outcome(g.moneyline, g.awayTeam);
    const fair = mh && ma ? noVig(mh.price, ma.price) : null;
    if (!fair) return null;
    const edgeHome = pHome - fair.a;
    if (Math.abs(edgeHome) < cfg.edge || Math.abs(edgeHome) > cfg.maxEdge) return null;
    const home = edgeHome > 0;
    const team = home ? g.homeTeam : g.awayTeam, price = (home ? mh : ma).price;
    const model = home ? pHome : 1 - pHome, market = home ? fair.a : fair.b;
    const strength = Math.abs(edgeHome) / cfg.edge;
    return {
      picker: STATS, market: "moneyline", bet: betText.moneyline(team), odds: price, strength,
      confidence: strength >= 2 ? "High" : strength >= 1.5 ? "Medium" : "Low",
      reason: `Run differential model gives ${team} ${pct(model)} to win (${nick(g.homeTeam)} ${H.pf}-${H.pa} runs in ${H.games} games, ${nick(g.awayTeam)} ${A.pf}-${A.pa} in ${A.games}; home field included) vs ${pct(market)} no-vig market. Starting pitchers aren't in this model.`,
    };
  }

  const rating = (t) => ((t.pf - t.pa) / t.games) * (t.games / (t.games + cfg.shrink));
  const rh = rating(H), ra = rating(A);
  const projHome = rh - ra + cfg.hfa; // projected home margin
  const sh = outcome(g.spread, g.homeTeam), sa = outcome(g.spread, g.awayTeam);
  if (!sh || !sa || sh.point == null) return null;
  const marketHome = -sh.point; // market's projected home margin
  const edge = projHome - marketHome;
  if (Math.abs(edge) < cfg.edge || Math.abs(edge) > cfg.maxEdge) return null;
  const home = edge > 0;
  const side = home ? sh : sa, team = home ? g.homeTeam : g.awayTeam;
  if (side.price == null) return null;
  const strength = Math.abs(edge) / cfg.edge;
  const lead = (m) => (m >= 0 ? `${nick(g.homeTeam)} by ${round1(m)}` : `${nick(g.awayTeam)} by ${round1(-m)}`);
  const per = (t) => `${(t.pf - t.pa) / t.games > 0 ? "+" : ""}${round1((t.pf - t.pa) / t.games)}`;
  return {
    picker: STATS, market: "spread", bet: betText.spread(team, side.point), odds: side.price, strength,
    confidence: strength >= 2 ? "High" : strength >= 1.5 ? "Medium" : "Low",
    reason: `Power ratings project ${lead(projHome)} (${nick(g.homeTeam)} ${per(H)} pts/game over ${H.games} games, ${nick(g.awayTeam)} ${per(A)} over ${A.games}, +${cfg.hfa} home field) vs the market's ${lead(marketHome)}. That's a ${round1(Math.abs(edge))}-point edge toward ${team}.`,
  };
}

// ---- 3) Value Contrarian Picker ------------------------------------------
const VALUE_MIN_EV = 0.015;   // 1.5% expected value vs the no-vig consensus
const VALUE_MAX_DOG = 250;    // skip long shots

export function valuePick(sport, g) {
  const books = g.allBooks || [];
  if (books.length < 3) return null; // need a real market to shop
  const options = [];
  const consider = (marketKey, pickName, otherName, wantPoint, label) => {
    const cp = outcome(g[marketKey], pickName), co = outcome(g[marketKey], otherName);
    if (!cp || !co || cp.price == null || co.price == null) return;
    const fair = noVig(cp.price, co.price);
    if (!fair) return;
    let best = null;
    for (const b of books) {
      const o = outcome(b[marketKey], pickName);
      if (!o || o.price == null) continue;
      if (wantPoint && Number(o.point) !== Number(cp.point)) continue; // same number only
      if (!best || americanToDecimal(o.price) > americanToDecimal(best.price)) best = { ...o, book: b.book };
    }
    if (!best) return;
    const ev = fair.a * (americanToDecimal(best.price) - 1) - (1 - fair.a);
    if (ev < VALUE_MIN_EV) return;
    options.push({ market: marketKey, label, best, consensus: cp, fair: fair.a, ev });
  };
  // Underdogs on the spread and moneyline, and unders.
  for (const [team, other] of [[g.homeTeam, g.awayTeam], [g.awayTeam, g.homeTeam]]) {
    const sp = outcome(g.spread, team);
    if (sp && sp.point > 0) consider("spread", team, other, true, "underdog");
    const ml = outcome(g.moneyline, team);
    if (ml && ml.price > 0 && ml.price <= VALUE_MAX_DOG) consider("moneyline", team, other, false, "underdog");
  }
  consider("total", "Under", "Over", true, "under");
  if (!options.length) return null;
  const o = options.sort((a, b) => b.ev - a.ev)[0];
  const bet = o.market === "total" ? betText.total("Under", o.best.point) : o.market === "spread" ? betText.spread(o.best.name, o.best.point) : betText.moneyline(o.best.name);
  const conPrice = o.market === "moneyline" ? fmtOdds(o.consensus.price) : `${fmtPoint(o.consensus.point)} ${fmtOdds(o.consensus.price)}`;
  return {
    picker: VALUE, market: o.market, bet, odds: o.best.price, strength: o.ev / VALUE_MIN_EV,
    confidence: o.ev >= 0.05 ? "High" : o.ev >= 0.03 ? "Medium" : "Low",
    reason: `${fmtOdds(o.best.price)} at ${o.best.book} beats the consensus ${conPrice}. The market's no-vig fair chance is ${pct(o.fair)}, so this price is worth about +${(o.ev * 100).toFixed(1)}% in expected value. Taking the ${o.label} the market is pricing against.`,
  };
}

// ---- Team ratings from ESPN standings ------------------------------------
const ESPN_LEAGUE = { nfl: "football/nfl", nba: "basketball/nba", mlb: "baseball/mlb" };
const ESPN_GROUP = {};
let standingsFetch = async (url) => {
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36", Accept: "application/json", Referer: "https://www.espn.com/" } });
  if (!res.ok) throw new Error(`ESPN standings ${res.status}`);
  return res.json();
};
export function __setStandingsFetch(fn) { standingsFetch = fn; }

export function parseStandings(json) {
  const out = {};
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    for (const e of node.standings?.entries || []) {
      // Overall stats only: ESPN repeats every stat for home/away/division
      // splits with a prefixed type ("homerecord_wins"); the overall one has
      // type === its name, lowercased.
      const stat = (...names) => {
        for (const n of names) {
          const s = (e.stats || []).find((x) => x.name === n && (!x.type || x.type === n.toLowerCase()));
          if (s && Number.isFinite(Number(s.value))) return Number(s.value);
        }
        return null;
      };
      // Games from the overall "W-L(-T)" record when present (college
      // standings often omit a separate losses stat).
      const overall = (e.stats || []).find((x) => x.type === "total" || x.name === "overall");
      const rec = String(overall?.displayValue || overall?.summary || "").match(/^(\d+)-(\d+)(?:-(\d+))?/);
      const w = rec ? Number(rec[1]) : stat("wins"), l = rec ? Number(rec[2]) : stat("losses"), t = rec ? Number(rec[3] || 0) : stat("ties") || 0;
      const pf = stat("pointsFor", "runsFor"), pa = stat("pointsAgainst", "runsAgainst");
      const games = (w ?? 0) + (l ?? 0) + t;
      const name = e.team?.displayName || [e.team?.location, e.team?.name].filter(Boolean).join(" ");
      if (!name || pf == null || pa == null || !games) continue;
      out[norm(name)] = { name, games, pf, pa, wins: w, losses: l };
    }
    for (const c of node.children || []) walk(c);
  };
  walk(json);
  return out;
}

export async function getTeamRatings(sport) {
  if (!ESPN_LEAGUE[sport]) return null; // stats picker covers pro leagues only
  return cached(`picker-ratings:${sport}`, async () => {
    const group = ESPN_GROUP[sport] ? `?group=${ESPN_GROUP[sport]}` : "";
    const json = await standingsFetch(`https://site.api.espn.com/apis/v2/sports/${ESPN_LEAGUE[sport]}/standings${group}`);
    return parseStandings(json);
  }, 6 * 3600);
}

// ---- Closing odds (for CLV) ------------------------------------------------
// Median of each book's last recorded price before kickoff, for the same
// market/side and (spread/total) the same number. Null if we can't tell.
export async function closingOdds(pick, parsed, game) {
  if (!pool || !pick.game_id) return null;
  const market = parsed.market;
  const side = market === "total" ? parsed.side : parsed.side === "home" ? game.homeTeam : game.awayTeam;
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (book) book, point, price FROM odds_snapshots
     WHERE game_id = $1 AND market = $2 AND side = $3 AND captured_at < $4
     ORDER BY book, captured_at DESC`,
    [pick.game_id, market, side, new Date(pick.kickoff_at).toISOString()]
  );
  const prices = rows.filter((r) => market === "moneyline" || Number(r.point) === Number(parsed.point)).map((r) => Number(r.price)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!prices.length) return null;
  // Median in probability space, back to American odds.
  const probs = prices.map(impliedProb).sort((a, b) => a - b);
  const p = probs[Math.floor(probs.length / 2)];
  const o = p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
  return Math.abs(o) >= 100 ? o : (o < 0 ? -100 : 100);
}

// ---- The run --------------------------------------------------------------
function pacificDay(d) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

async function postPicks({ now, dryRun, log }) {
  const { rows: existing } = await pool.query("SELECT picker, sport, game, game_id, kickoff_at, created_at FROM picks WHERE kickoff_at > $1", [new Date(now - hours(48)).toISOString()]);
  const already = new Set(existing.map((p) => `${p.picker}|${p.game_id || norm(p.game)}`));
  const today = pacificDay(new Date(now));
  const count = {};
  for (const p of existing) {
    if (pacificDay(new Date(p.created_at)) !== today) continue;
    count[p.picker] = (count[p.picker] || 0) + 1;
    count[`${p.picker}|${p.sport}`] = (count[`${p.picker}|${p.sport}`] || 0) + 1;
  }
  const candidates = [];
  for (const sport of SPORTS) {
    if (!inSeason(sport, new Date(now))) continue;
    let games;
    try { games = await getOddsForSport(sport); } catch (err) { log.errors.push(`${sport} odds: ${err.message}`); continue; }
    const soon = (games || []).filter((g) => {
      const t = Date.parse(g.commenceTime);
      return t - now > hours(0.5) && t - now <= hours(24);
    });
    if (!soon.length) continue;
    let ratings = null;
    try { ratings = await getTeamRatings(sport); } catch (err) { log.errors.push(`${sport} standings: ${err.message}`); }
    for (const g of soon) {
      const until = (Date.parse(g.commenceTime) - now) / 3600e3;
      const inWindow = (picker) => until > WINDOW[picker][0] && until <= WINDOW[picker][1];
      const tries = [];
      if (inWindow(LINE)) {
        const h = await getLineHistory(g.id, g.lineTrackingBook).catch(() => null);
        tries.push(lineMovementPick(sport, g, h));
      }
      if (inWindow(STATS)) tries.push(statsPick(sport, g, ratings));
      if (inWindow(VALUE)) tries.push(valuePick(sport, g));
      for (const c of tries) if (c) candidates.push({ ...c, sport, g });
    }
  }
  candidates.sort((a, b) => b.strength - a.strength);
  for (const c of candidates) {
    const key = `${c.picker}|${c.g.id}`;
    if (already.has(key)) { log.skipped.push(`${c.picker}: already picked ${c.g.awayTeam} @ ${c.g.homeTeam}`); continue; }
    if ((count[c.picker] || 0) >= DAILY_CAP || (count[`${c.picker}|${c.sport}`] || 0) >= DAILY_SPORT_CAP) {
      log.skipped.push(`${c.picker}: daily cap — ${c.bet}`);
      continue;
    }
    const pick = {
      picker: c.picker, sport: c.sport, game: `${c.g.awayTeam} @ ${c.g.homeTeam}`, game_id: c.g.id,
      kickoff_at: c.g.commenceTime, bet: c.bet, odds: c.odds, confidence: c.confidence, reason: c.reason,
    };
    if (dryRun) { log.wouldPost.push(pick); already.add(key); count[c.picker] = (count[c.picker] || 0) + 1; count[`${c.picker}|${c.sport}`] = (count[`${c.picker}|${c.sport}`] || 0) + 1; continue; }
    const r = await savePick(pick);
    if (r.status === "created") {
      log.posted.push(r.pick);
      already.add(key);
      count[c.picker] = (count[c.picker] || 0) + 1;
      count[`${c.picker}|${c.sport}`] = (count[`${c.picker}|${c.sport}`] || 0) + 1;
    } else if (r.status === "rejected") log.errors.push(`${c.picker} ${c.bet}: ${r.error}`);
  }
}

async function gradeFinished({ now, dryRun, log }) {
  const { rows } = await pool.query("SELECT * FROM picks WHERE result = 'pending' AND kickoff_at < $1 ORDER BY kickoff_at", [new Date(now - hours(GRADE_AFTER_HOURS)).toISOString()]);
  if (!rows.length) return;
  const bySport = {};
  for (const p of rows) (bySport[p.sport] ||= []).push(p);
  for (const [sport, picks] of Object.entries(bySport)) {
    let scores = {};
    try { scores = await getScoresForSport(sport, 3); } catch (err) { log.errors.push(`${sport} scores: ${err.message}`); continue; }
    const list = Object.entries(scores).map(([id, s]) => ({ id, ...s }));
    for (const p of picks) {
      const k = Date.parse(p.kickoff_at);
      let s = p.game_id ? scores[p.game_id] : null;
      if (!s) {
        const [away, home] = String(p.game).split(" @ ").map(norm);
        s = list.find((x) => norm(x.homeTeam) === home && norm(x.awayTeam) === away && Math.abs(Date.parse(x.commenceTime) - k) < hours(12));
      }
      const tooOld = now - k > VOID_AFTER_DAYS * 86400e3;
      if (!s || !s.completed) {
        if (tooOld) {
          if (!dryRun) { const r = await gradePick({ id: p.id, result: "void" }); if (r.status === "graded") log.graded.push({ id: p.id, result: "void", note: "no final score found" }); }
          else log.wouldGrade.push({ id: p.id, result: "void" });
        }
        continue;
      }
      const [awayName, homeName] = String(p.game).split(" @ ");
      const parsed = parseBet(p.bet, s.homeTeam || homeName, s.awayTeam || awayName);
      const result = gradeBet(parsed, s.homeScore, s.awayScore);
      if (!result) { log.errors.push(`Couldn't grade pick ${p.id} (${p.bet}) automatically — grade it with /api/picks/grade.`); continue; }
      const closing = await closingOdds(p, parsed, { homeTeam: s.homeTeam || homeName, awayTeam: s.awayTeam || awayName }).catch(() => null);
      if (dryRun) { log.wouldGrade.push({ id: p.id, bet: p.bet, result, closing_odds: closing }); continue; }
      const r = await gradePick({ id: p.id, result, closing_odds: closing });
      if (r.status === "graded") log.graded.push({ id: p.id, bet: p.bet, result, units: r.pick.units, closing_odds: closing });
      else log.errors.push(`grade ${p.id}: ${r.error}`);
    }
  }
}

// Once-a-day scheduling: the first check at or after DAILY_HOUR (Pacific)
// on a given day claims that day in picker_runs and runs; every other check
// that day is a no-op. Safe to call as often as you like (hourly timer on
// the server + the GitHub Actions ping).
export async function runDailyIfDue({ now = Date.now() } = {}) {
  if (!pool) return { ok: false, error: "No database." };
  await ensureSchema();
  const d = new Date(now);
  const hour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(d));
  const day = pacificDay(d);
  if (hour < DAILY_HOUR) return { ok: true, due: false, reason: `Runs at ${DAILY_HOUR}:00 Pacific; it's ${hour}:00.`, day };
  const claim = await pool.query("INSERT INTO picker_runs (day) VALUES ($1) ON CONFLICT (day) DO NOTHING RETURNING day", [day]);
  if (!claim.rows.length) return { ok: true, due: false, reason: `Already ran today (${day}).`, day };
  const result = await runPickers({ now });
  await pool.query("UPDATE picker_runs SET finished_at = now(), summary = $2 WHERE day = $1", [day, JSON.stringify({ posted: result.posted?.length || 0, graded: result.graded?.length || 0, errors: result.errors || [], error: result.error || null })]);
  if (result.ok === false) await pool.query("DELETE FROM picker_runs WHERE day = $1", [day]); // let a later check retry
  return { ...result, due: true, day };
}

// One run at a time across all server instances (Postgres advisory lock).
const LOCK_ID = 74210931;
export async function runPickers({ dryRun = false, post = true, grade = true, now = Date.now() } = {}) {
  if (!pool) return { ok: false, error: "No database." };
  await ensureSchema();
  const client = await pool.connect();
  const log = { ok: true, dryRun, startedAt: new Date(now).toISOString(), posted: [], graded: [], wouldPost: [], wouldGrade: [], skipped: [], errors: [] };
  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS got", [LOCK_ID]);
    if (!rows[0].got) return { ok: false, error: "A picker run is already in progress." };
    try {
      if (grade) await gradeFinished({ now, dryRun, log });
      if (post) await postPicks({ now, dryRun, log });
    } finally {
      await client.query("SELECT pg_advisory_unlock($1)", [LOCK_ID]);
    }
  } finally {
    client.release();
  }
  log.finishedAt = new Date().toISOString();
  console.log(`[pickers] ${dryRun ? "dry run" : "run"}: posted ${log.posted.length || log.wouldPost.length}, graded ${log.graded.length || log.wouldGrade.length}, errors ${log.errors.length}`);
  return log;
}
