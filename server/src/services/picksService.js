// Public picks ledger: the math (implied probability, units, no-vig, CLV)
// and the leaderboard. Pure functions so the tests and the routes agree.

export const PICKERS = ["Line Movement Picker", "Matchup Stats Picker", "Value Contrarian Picker"];
export const CONFIDENCES = ["Low", "Medium", "High"];
export const RESULTS = ["pending", "win", "loss", "push", "void"];
export const SPORTS = ["nfl", "nba", "mlb", "ncaaf", "ncaab"];

// American odds -> implied probability (with the vig still in).
export function impliedProb(odds) {
  const o = Number(odds);
  if (!Number.isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : -o / (-o + 100);
}

export function validOdds(odds) {
  const o = Number(odds);
  return Number.isInteger(o) && Math.abs(o) >= 100 && Math.abs(o) <= 100000;
}

const round = (n, dp) => Math.round(n * 10 ** dp) / 10 ** dp;

// Flat 1-unit stake: win at +odds pays odds/100, win at -odds pays
// 100/|odds|, loss -1, push/void 0. Rounded to cents of a unit.
export function unitsFor(result, odds) {
  const o = Number(odds);
  if (result === "win") return round(o > 0 ? o / 100 : 100 / Math.abs(o), 2);
  if (result === "loss") return -1;
  if (result === "push" || result === "void") return 0;
  return null;
}

// Two-way market (spread, total, 2-way moneyline): remove the bookmaker's
// margin so the two sides add to 100%.
export function noVig(oddsA, oddsB) {
  const a = impliedProb(oddsA), b = impliedProb(oddsB);
  if (a == null || b == null) return null;
  return { a: a / (a + b), b: b / (a + b), hold: a + b - 1 };
}

// Closing-line value in percentage points of implied probability: positive
// means the pick got a better price than the market closed at.
export function clvPoints(odds, closingOdds) {
  const a = impliedProb(odds), c = impliedProb(closingOdds);
  if (a == null || c == null) return null;
  return (c - a) * 100;
}

// Start of the current season for a sport, for the "season" range.
export function seasonStart(sport, now = new Date()) {
  const startMonth = { nfl: 7, ncaaf: 7, nba: 9, ncaab: 10, mlb: 2 }[sport] ?? 7; // 0-based: Aug, Aug, Oct, Nov, Mar
  const y = now.getUTCFullYear();
  const thisYear = Date.UTC(y, startMonth, 1);
  return new Date(now.getTime() >= thisYear ? thisYear : Date.UTC(y - 1, startMonth, 1));
}

export function rangeFilter(range, now = new Date()) {
  const day = 86400e3;
  if (range === "7d") return (p) => new Date(p.kickoff_at) >= new Date(now - 7 * day);
  if (range === "30d") return (p) => new Date(p.kickoff_at) >= new Date(now - 30 * day);
  if (range === "season") return (p) => new Date(p.kickoff_at) >= seasonStart(p.sport, now);
  return () => true;
}

function blankStats() {
  return { picks: 0, graded: 0, pending: 0, void: 0, wins: 0, losses: 0, pushes: 0, units: 0 };
}
function addTo(s, p) {
  s.picks++;
  if (p.result === "pending") { s.pending++; return; }
  if (p.result === "void") { s.void++; return; }
  s.graded++;
  if (p.result === "win") s.wins++;
  else if (p.result === "loss") s.losses++;
  else if (p.result === "push") s.pushes++;
  s.units += Number(p.units || 0);
}
function finish(s) {
  return {
    ...s,
    units: round(s.units, 2),
    winPct: s.wins + s.losses ? round((s.wins / (s.wins + s.losses)) * 100, 1) : null,
    roi: s.graded ? round((s.units / s.graded) * 100, 1) : null, // % per unit risked
  };
}

// rows: picks already filtered to the range/sport. Every known picker gets
// an entry, even with no picks, so the Record page always shows all three.
export function buildLeaderboard(rows) {
  const names = [...new Set([...PICKERS, ...rows.map((r) => r.picker)])];
  const out = names.map((name) => {
    const mine = rows.filter((r) => r.picker === name);
    const s = blankStats();
    const byConf = Object.fromEntries(CONFIDENCES.map((c) => [c, blankStats()]));
    let impliedSum = 0, impliedN = 0, clvSum = 0, clvN = 0;
    for (const p of mine) {
      addTo(s, p);
      if (byConf[p.confidence]) addTo(byConf[p.confidence], p);
      if (p.result !== "void" && p.implied_prob != null) { impliedSum += Number(p.implied_prob); impliedN++; }
      if (p.closing_odds != null && p.result !== "void") {
        const c = clvPoints(p.odds, p.closing_odds);
        if (c != null) { clvSum += c; clvN++; }
      }
    }
    // Graded wins/losses, oldest first by kickoff, for streak + units chart.
    const graded = mine
      .filter((p) => ["win", "loss", "push"].includes(p.result))
      .sort((a, b) => new Date(a.kickoff_at) - new Date(b.kickoff_at) || Number(a.id) - Number(b.id));
    let cum = 0;
    const series = graded.map((p) => ({ t: new Date(p.kickoff_at).toISOString(), units: round((cum += Number(p.units || 0)), 2) }));
    let streak = null;
    for (let i = graded.length - 1; i >= 0; i--) {
      const r = graded[i].result;
      if (r === "push") continue;
      if (!streak) streak = { type: r === "win" ? "W" : "L", count: 1 };
      else if ((r === "win" ? "W" : "L") === streak.type) streak.count++;
      else break;
    }
    return {
      picker: name,
      ...finish(s),
      avgImpliedProb: impliedN ? round((impliedSum / impliedN) * 100, 1) : null,
      byConfidence: Object.fromEntries(Object.entries(byConf).map(([k, v]) => [k, finish(v)])),
      streak: streak ? `${streak.type}${streak.count}` : null,
      clv: clvN ? { avgPoints: round(clvSum / clvN, 2), picks: clvN } : null,
      smallSample: s.graded < 100,
      series: series.length > 200 ? series.filter((_, i) => i % Math.ceil(series.length / 200) === 0 || i === series.length - 1) : series,
    };
  });
  // Rank by units, then ROI; pickers with nothing graded go last.
  return out.sort((a, b) => (b.graded > 0) - (a.graded > 0) || b.units - a.units || (b.roi ?? -1e9) - (a.roi ?? -1e9));
}

// Which side of which market a bet is on, to spot pickers disagreeing.
export function betSide(bet, homeTeam, awayTeam) {
  const b = String(bet || "").toLowerCase();
  if (/^\s*(over|o)\s*\d/.test(b) || /\bover\b/.test(b)) return { market: "total", side: "over" };
  if (/^\s*(under|u)\s*\d/.test(b) || /\bunder\b/.test(b)) return { market: "total", side: "under" };
  const nick = (t) => String(t || "").toLowerCase().split(" ").filter((w) => w.length > 2);
  const hits = (t) => nick(t).filter((w) => b.includes(w)).length;
  const h = hits(homeTeam), a = hits(awayTeam);
  if (h > a) return { market: "side", side: "home" };
  if (a > h) return { market: "side", side: "away" };
  return null;
}

export function pickersDisagree(picks, homeTeam, awayTeam) {
  const sides = {};
  for (const p of picks) {
    const s = betSide(p.bet, homeTeam, awayTeam);
    if (!s) continue;
    (sides[s.market] ||= new Set()).add(s.side);
  }
  return Object.values(sides).some((set) => set.size > 1);
}

// Public row shape (numbers as numbers).
export function toPublic(r) {
  return {
    id: Number(r.id),
    picker: r.picker,
    sport: r.sport,
    game: r.game,
    game_id: r.game_id || null,
    kickoff_at: new Date(r.kickoff_at).toISOString(),
    bet: r.bet,
    odds: Number(r.odds),
    implied_prob: r.implied_prob == null ? null : Number(r.implied_prob),
    confidence: r.confidence,
    reason: r.reason,
    result: r.result,
    units: r.units == null ? null : Number(r.units),
    closing_odds: r.closing_odds == null ? null : Number(r.closing_odds),
    created_at: new Date(r.created_at).toISOString(),
    graded_at: r.graded_at ? new Date(r.graded_at).toISOString() : null,
  };
}

const CSV_COLS = ["id", "created_at", "picker", "sport", "game", "kickoff_at", "bet", "odds", "implied_prob", "confidence", "result", "units", "closing_odds", "graded_at", "reason"];
export function toCsv(rows) {
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [CSV_COLS.join(","), ...rows.map((r) => CSV_COLS.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}
