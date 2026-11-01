import { Router } from "express";
import { pool, ensureSchema } from "../db.js";
import { withTier } from "../middleware/tier.js";
import { dailyLimit } from "../middleware/limits.js";
import { userTimeLine, localLabel, currentTz } from "../services/timeService.js";
import { getOddsForSport } from "../services/oddsService.js";
import { getMatchupInjuries, normalizePlayerName } from "../services/injuryService.js";
import { getSlate, getGameProps, PROPS_SPORTS, PROP_MARKETS } from "../services/propsService.js";

// ---------------------------------------------------------------------------
// Props Edge — DraftKings player props (NFL, NBA) and AI edge picks.
//
//   GET  /api/props/slate?sport=nba&day=today|tomorrow   games (no credits)
//   GET  /api/props/game/:sport/:eventId                 DraftKings props + edge math
//   POST /api/props/edge/:sport/:eventId                 AI edge picks (daily limit)
//
// The prop board is free for everyone. AI picks need an account and count
// against the plan's daily "props" limit. The numbers on every pick (line,
// price, fair odds, EV) come from our data, never from the model.
// ---------------------------------------------------------------------------

const router = Router();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.PROPS_MODEL || process.env.CHAT_MODEL || "claude-sonnet-5";
const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED !== "false";
const WEB_SEARCH_TOOL_TYPE = process.env.WEB_SEARCH_TOOL_TYPE || "web_search_20250305";
const norm = normalizePlayerName;

let callModelImpl = callAnthropic;
export function __setModelCaller(fn) { callModelImpl = fn; }

async function callAnthropic(body) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    const err = new Error(`Anthropic API error ${response.status}: ${text}`);
    err.status = response.status;
    err.body = text;
    throw err;
  }
  return response.json();
}

const sportOf = (s) => String(s || "").toLowerCase();
function badSport(res, sport) {
  if (PROPS_SPORTS.includes(sport)) return false;
  res.status(400).json({ error: "Props Edge covers NFL and NBA." });
  return true;
}

// Only games on the odds board (or already pulled) can be fetched, so a
// made-up event id can never spend credits.
async function findGame(sport, eventId) {
  const games = (await getOddsForSport(sport).catch(() => [])) || [];
  return games.find((g) => g.id === eventId) || null;
}

router.get("/slate", async (req, res, next) => {
  try {
    const sport = sportOf(req.query.sport || "nba");
    if (badSport(res, sport)) return;
    const day = req.query.day === "tomorrow" ? "tomorrow" : "today";
    res.json(await getSlate(sport, { day }));
  } catch (err) {
    next(err);
  }
});

router.get("/game/:sport/:eventId", async (req, res, next) => {
  try {
    const sport = sportOf(req.params.sport);
    if (badSport(res, sport)) return;
    const { eventId } = req.params;
    const game = await findGame(sport, eventId);
    if (!game) {
      // Allow a game that has dropped off the board (started) if we already pulled it.
      const r = await getGameProps(sport, eventId, { onlyCached: true }).catch(() => null);
      if (!r?.data) return res.status(404).json({ error: "That game isn't on today's board." });
      return res.json(r);
    }
    res.json(await getGameProps(sport, eventId, { commenceTime: game.commenceTime }));
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    next(err);
  }
});

// ---- AI edge picks -------------------------------------------------------------

const memPicks = new Map(); // `${eventId}|${fetchedAt}` -> picks
const inflight = new Map();

async function loadPicks(eventId, fetchedAt) {
  const k = `${eventId}|${fetchedAt}`;
  if (memPicks.has(k)) return memPicks.get(k);
  if (!pool) return null;
  try {
    await ensureSchema();
    const { rows } = await pool.query("SELECT data FROM props_ai_picks WHERE event_id = $1 AND props_fetched_at = $2", [eventId, fetchedAt]);
    if (rows.length) { memPicks.set(k, rows[0].data); return rows[0].data; }
  } catch (err) {
    console.error("[props] picks read failed:", err.message);
  }
  return null;
}

async function savePicks(eventId, fetchedAt, data) {
  memPicks.set(`${eventId}|${fetchedAt}`, data);
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO props_ai_picks (event_id, props_fetched_at, data) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [eventId, fetchedAt, JSON.stringify(data)]
    );
  } catch (err) {
    console.error("[props] picks write failed:", err.message);
  }
}

// The props table sent to the model: the strongest edges plus enough of
// everything else that it can weigh role and matchup, kept compact.
export function propsForModel(props, max = 45) {
  const scored = props.map((p) => ({ p, s: Math.max(p.best?.ev ?? -99, Math.abs(p.lineGap ?? 0) * 2, (p.priceGap ?? -99) / 2) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, max).map(({ p }) => {
    const row = { player: p.player, market: p.market, marketLabel: p.marketLabel };
    if (p.kind === "ou") {
      Object.assign(row, {
        dkLine: p.line, dkOver: p.over, dkUnder: p.under,
        fairOverPct: p.fair?.over ?? null, evOverPct: p.ev?.over ?? null, evUnderPct: p.ev?.under ?? null,
        marketMedianLine: p.consensusLine, booksCompared: p.booksCompared,
      });
    } else {
      Object.assign(row, { dkYes: p.yes, dkImpliedPct: p.dkImplied?.yes ?? null, otherBooksAvgImpliedPct: p.marketAvgImplied, booksCompared: p.booksCompared });
    }
    return row;
  });
}

function injuriesForModel(inj) {
  const side = (r) => r ? {
    team: r.team,
    reportStatus: r.status,
    source: r.source,
    retrieved_at: r.retrieved_at,
    players: (r.players || []).filter((p) => p.gameDesignation).slice(0, 25).map((p) => ({ name: p.name, position: p.position, status: p.gameDesignation, injury: p.injury })),
  } : null;
  return inj ? { home: side(inj.homeTeam), away: side(inj.awayTeam) } : null;
}

function systemPrompt({ sport, webSearchOn, nowIso }) {
  return `You are Props Edge, BetEdge AI's player-prop analyst for the ${sport.toUpperCase()}. Current time: ${nowIso} (UTC). ${userTimeLine(nowIso)}

You get DraftKings player props for one game, with market math computed by the server from up to 9 other US sportsbooks:
- fairOverPct: no-vig probability of the Over from other books posting the same line.
- evOverPct / evUnderPct: expected value of betting that side at DraftKings' price, using that fair probability. Positive = DraftKings is mispriced in the bettor's favor.
- marketMedianLine vs dkLine: if DraftKings' line is lower than the market's, the Over is cheaper there (and vice versa).
- Anytime TD: otherBooksAvgImpliedPct higher than dkImpliedPct means DraftKings pays more than the market.

Pick up to 3 of the best DraftKings props in this game. Weigh price value (EV, line gaps) together with role, matchup, pace/game script, and injuries — including teammates who are out and who absorbs their volume.

Rules:
1. Only pick props from the table, using its exact player and market values.
2. ${webSearchOn ? "web_search is available (use it sparingly) for news newer than the injury feed: a player ruled out, a starter returning, minutes limits. Prefer official team/league sources and established outlets (ESPN, AP, The Athletic, NBA.com, NFL.com)." : "Web search is unavailable; rely on the data and say when something couldn't be verified."}
3. A player missing from an injury report is NOT confirmed healthy. Never pick a player listed Out. Flag Questionable/Doubtful players as risk.
4. Do not invent stats. If you rely on general knowledge of a player's role, say it is a general read, not a stat.
5. Fewer than 3 picks — or none — is fine if nothing stands out. Never guarantee results.

Respond with ONLY this JSON (no prose, no code fences):
{"summary":"one sentence on how this game sets up for props","picks":[{"player":"exact name","market":"exact market key","side":"Over|Under|Yes","confidence":"Lean|Solid|Strong","reason":"2 short sentences: the price edge and the matchup/role case","risk":"one short sentence"}]}`;
}

export function parseJson(text) {
  try { return JSON.parse(text); } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("No JSON in model reply");
    return JSON.parse(m[0]);
  }
}

async function runModel({ sport, userContent }) {
  let webSearchOn = WEB_SEARCH_ENABLED;
  const nowIso = new Date().toISOString();
  const messages = [{ role: "user", content: userContent }];
  const sources = [];
  let data = null;
  for (let round = 0; round < 6; round++) {
    const tools = webSearchOn ? [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: 3 }] : undefined;
    try {
      data = await callModelImpl({ model: MODEL, max_tokens: 3000, system: systemPrompt({ sport, webSearchOn, nowIso }), ...(tools ? { tools } : {}), messages });
    } catch (err) {
      if (webSearchOn && err.status === 400 && /web_search|server tool|tool type/i.test(err.body || "")) { webSearchOn = false; continue; }
      throw err;
    }
    for (const b of data.content || []) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) sources.push({ label: r.title || r.url, url: r.url });
      }
    }
    if (data.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: data.content });
  }
  const content = data?.content || [];
  let lastTool = -1;
  content.forEach((b, i) => { if (["server_tool_use", "web_search_tool_result", "tool_use"].includes(b.type)) lastTool = i; });
  let text = content.slice(lastTool + 1).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  let json;
  try {
    json = parseJson(text);
  } catch {
    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: "Respond now with ONLY the JSON object in the requested shape." });
    const retry = await callModelImpl({ model: MODEL, max_tokens: 2000, system: systemPrompt({ sport, webSearchOn: false, nowIso }), messages });
    text = (retry.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
    json = parseJson(text);
  }
  return { json, sources, webSearchOn };
}

// Keep only picks that match a real DraftKings prop, and attach our numbers.
export function attachPickData(rawPicks, props) {
  const byKey = new Map(props.map((p) => [`${p.market}|${norm(p.player)}`, p]));
  const out = [];
  for (const pk of Array.isArray(rawPicks) ? rawPicks : []) {
    const prop = byKey.get(`${pk.market}|${norm(pk.player)}`);
    if (!prop) continue;
    const side = prop.kind === "yes" ? "Yes" : (/^under$/i.test(pk.side) ? "Under" : /^over$/i.test(pk.side) ? "Over" : null);
    if (!side) continue;
    if (out.some((o) => o.id === prop.id)) continue;
    const conf = ["Lean", "Solid", "Strong"].includes(pk.confidence) ? pk.confidence : "Lean";
    out.push({
      id: prop.id,
      player: prop.player,
      market: prop.market,
      marketLabel: prop.marketLabel,
      side,
      line: prop.line,
      price: side === "Over" ? prop.over : side === "Under" ? prop.under : prop.yes,
      ev: side === "Over" ? prop.ev?.over ?? null : side === "Under" ? prop.ev?.under ?? null : null,
      fairPct: side === "Over" ? prop.fair?.over ?? null : side === "Under" ? prop.fair?.under ?? null : null,
      consensusLine: prop.consensusLine ?? null,
      priceGap: prop.priceGap ?? null,
      confidence: conf,
      reason: String(pk.reason || "").slice(0, 400),
      risk: String(pk.risk || "").slice(0, 200),
    });
    if (out.length >= 3) break;
  }
  return out;
}

async function buildPicks(sport, eventId, game, propsData) {
  const injuries = await getMatchupInjuries(sport, propsData.homeTeam || game?.homeTeam, propsData.awayTeam || game?.awayTeam).catch(() => null);
  const payload = {
    game: {
      away: propsData.awayTeam, home: propsData.homeTeam,
      kickoff_local: localLabel(propsData.commenceTime, currentTz()),
      spread: game?.spread || null, total: game?.total || null,
    },
    props: propsForModel(propsData.props),
    injuries: injuriesForModel(injuries),
  };
  const { json, sources } = await runModel({ sport, userContent: `Game data (JSON):\n${JSON.stringify(payload)}` });
  const picks = attachPickData(json?.picks, propsData.props);
  const src = [];
  if (injuries?.homeTeam?.source) src.push({ label: `${injuries.homeTeam.source} injury report`, url: injuries.homeTeam.source_url || null });
  for (const s of sources) if (!src.some((x) => x.url === s.url)) src.push(s);
  return {
    summary: String(json?.summary || "").slice(0, 300),
    picks,
    sources: src.slice(0, 6),
    generatedAt: new Date().toISOString(),
  };
}

router.post("/edge/:sport/:eventId", withTier, dailyLimit("props"), async (req, res, next) => {
  try {
    const sport = sportOf(req.params.sport);
    if (badSport(res, sport)) return;
    const { eventId } = req.params;
    const game = await findGame(sport, eventId);
    const pr = game ? await getGameProps(sport, eventId, { commenceTime: game.commenceTime }) : await getGameProps(sport, eventId, { onlyCached: true });
    if (!pr?.data) return res.status(409).json({ error: pr?.pausedReason || "Props for this game aren't loaded yet." });
    if (!pr.data.props?.length) return res.status(409).json({ error: "DraftKings hasn't posted player props for this game yet." });

    const cached = await loadPicks(eventId, pr.fetchedAt);
    if (cached) return res.json({ ...cached, propsFetchedAt: pr.fetchedAt, fromCache: true });

    const k = `${eventId}|${pr.fetchedAt}`;
    if (!inflight.has(k)) {
      inflight.set(k, buildPicks(sport, eventId, game, pr.data)
        .then(async (out) => { await savePicks(eventId, pr.fetchedAt, out); return out; })
        .finally(() => inflight.delete(k)));
    }
    const out = await inflight.get(k);
    res.json({ ...out, propsFetchedAt: pr.fetchedAt, fromCache: false });
  } catch (err) {
    console.error("[props] edge picks failed:", err.message);
    res.status(502).json({ error: "Couldn't generate AI picks right now. Please try again in a minute." });
  }
});

router.get("/markets", (_req, res) => res.json(PROP_MARKETS));

export default router;
