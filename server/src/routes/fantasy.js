import { Router } from "express";
import { withTier, requireTier } from "../middleware/tier.js";
import { dailyLimit } from "../middleware/limits.js";
import {
  getPlayerReport,
  getTeamContext,
  getOpportunityReport,
  findPlayer,
  normalizeScoring,
  SCORING,
  playerInjuryStatus,
  searchPlayers,
  normalizeQueryName,
} from "../services/fantasyDataService.js";
import { normalizePlayerName } from "../services/injuryService.js";

// ---------------------------------------------------------------------------
// Fantasy Edge — AI fantasy decisions (NFL), grounded in the same live data
// the rest of BetEdge uses. Not league hosting: users bring their roster
// (typed or as a screenshot from ESPN/Yahoo/Sleeper/CBS/NFL) and get
// start/sit, waiver, lineup, injury-impact and trade analysis.
//
// Two things are enforced on the server, not left to the model:
//   1. Every player shown carries injury status + source + last updated from
//      our data, and "STATUS UNCONFIRMED" when it can't be verified.
//   2. The Fantasy Edge Score (0–100) is computed here from the model's
//      per-factor ratings with fixed weights, so it's consistent everywhere.
// ---------------------------------------------------------------------------

const router = Router();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.FANTASY_MODEL || process.env.CHAT_MODEL || "claude-sonnet-5";
const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED !== "false";
const WEB_SEARCH_TOOL_TYPE = process.env.WEB_SEARCH_TOOL_TYPE || "web_search_20250305";
const MAX_TOOL_ROUNDS = 10;
const norm = normalizePlayerName;

// Swappable for tests.
let callModelImpl = callAnthropic;
export function __setModelCaller(fn) {
  callModelImpl = fn;
}

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

// ---- Fantasy Edge Score ----------------------------------------------------

export const EDGE_WEIGHTS = {
  usage: 20,
  matchup: 15,
  opportunity: 15,
  injury: 10, // his own health + how settled his team situation is
  trend: 10,
  gameEnvironment: 10,
  roleSecurity: 10,
  redZone: 5,
  schedule: 5,
};

export function edgeLabel(score) {
  if (score >= 85) return { tier: "elite", label: "ELITE", icon: "🔥" };
  if (score >= 70) return { tier: "strong", label: "STRONG", icon: "▲" };
  if (score >= 55) return { tier: "solid", label: "SOLID", icon: "●" };
  if (score >= 40) return { tier: "risky", label: "RISKY", icon: "⚠" };
  return { tier: "avoid", label: "AVOID", icon: "▼" };
}

export function computeEdgeScore(components, status) {
  if (!components || typeof components !== "object") return null;
  let total = 0;
  let weightUsed = 0;
  for (const [k, w] of Object.entries(EDGE_WEIGHTS)) {
    const v = Number(components[k]);
    if (!Number.isFinite(v)) continue;
    total += (Math.max(0, Math.min(10, v)) / 10) * w;
    weightUsed += w;
  }
  if (!weightUsed) return null;
  let score = Math.round((total / weightUsed) * 100);
  const d = String(status?.designation || "").toLowerCase();
  if (/^(out|injured reserve|ir|suspended|pup)/.test(d)) score = Math.min(score, 5);
  else if (/^doubtful/.test(d)) score = Math.min(score, 25);
  const lbl = /^(out|injured reserve|ir|suspended|pup)/.test(d) ? { tier: "out", label: "OUT", icon: "✕" } : edgeLabel(score);
  return { score, ...lbl };
}

const EDGE_RUBRIC = `FANTASY EDGE SCORE — rate each factor 0–10 (10 = best possible for fantasy this week). The server combines them with fixed weights, so rate each factor on its own evidence:
- usage (20%): targets/touches/pass attempts from recentGames.usage
- matchup (15%): opponentDefense ranks vs his position (pass defense for QB/WR/TE, rush defense for RB)
- opportunity (15%): room for volume growth — injured teammates, vacated targets, depth chart
- injury (10%): his own status (10 = no designation on a fresh report; unconfirmed status caps this at 6)
- trend (10%): trendLast2VsPrior and recent fantasy points
- gameEnvironment (10%): game total, spread (favored teams run more; trailing teams pass more), weather
- roleSecurity (10%): depth chart rank and whether his job is threatened
- redZone (5%): touchdown volume (the closest available proxy)
- schedule (5%): upcoming opponents beyond this week if known; else 5
If a factor's data is unavailable, give 5 and say so in the reasoning.`;

// ---- Tools -----------------------------------------------------------------

const TOOLS = [
  {
    name: "get_player_report",
    description:
      "Current NFL player report: team, position, injury status (designation, practice status, source, last updated, conflicts), depth-chart rank, last 5 games with fantasy points in the requested scoring, usage averages (targets, carries, touches), trend, upcoming game (opponent, kickoff, spread, total, weather), and opponent defense ranks. Call this for EVERY player you evaluate, before judging him. status.label 'STATUS UNCONFIRMED' means his status could not be verified — never call him healthy.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        team: { type: "string", description: "Optional team name/abbreviation to disambiguate." },
        position: { type: "string", description: "Optional position (QB/RB/WR/TE/K)." },
        force_refresh: { type: "boolean" },
      },
      required: ["name"],
    },
  },
  {
    name: "get_team_context",
    description:
      "An NFL team's current depth chart at QB/RB/WR/TE/K with each player's injury status, the team's full injury report (source, updated time, conflicts), and its upcoming game. Use for injury impact (who absorbs the work) and team-situation questions.",
    input_schema: { type: "object", properties: { team: { type: "string" }, force_refresh: { type: "boolean" } }, required: ["team"] },
  },
  {
    name: "get_waiver_opportunities",
    description:
      "League-wide list of fantasy starters currently listed Out/Doubtful/IR and who is next on each depth chart behind them. Starting point for waiver targets. It does NOT know which players are available in the user's league.",
    input_schema: { type: "object", properties: { position: { type: "string", enum: ["ALL", "QB", "RB", "WR", "TE"] } } },
  },
];

function makeToolRunner(state) {
  return async function run(name, input = {}) {
    if (name === "get_player_report") {
      const r = await getPlayerReport(input.name, {
        team: input.team,
        position: input.position,
        scoring: state.scoring,
        forceRefresh: !!input.force_refresh,
      });
      if (r.found) {
        state.players.set(norm(r.player.name), r);
        state.players.set(norm(input.name), r);
        if (r.status?.source) state.sources.push({ label: `${r.status.source} injury report — ${r.player.team}`, url: r.status.source_url, retrieved_at: r.status.retrieved_at, kind: "data" });
      }
      return r;
    }
    if (name === "get_team_context") {
      const r = await getTeamContext(input.team, { forceRefresh: !!input.force_refresh });
      if (r.injuryReport?.source) state.sources.push({ label: `${r.injuryReport.source} injury report — ${r.team}`, url: r.injuryReport.source_url, retrieved_at: r.injuryReport.retrieved_at, kind: "data" });
      if (r.depthChart?.source) state.sources.push({ label: `${r.depthChart.source} depth chart — ${r.team}`, retrieved_at: r.depthChart.retrieved_at, kind: "data" });
      return r;
    }
    if (name === "get_waiver_opportunities") {
      return getOpportunityReport({ position: input.position || state.position || "ALL" });
    }
    throw new Error(`Unknown tool ${name}`);
  };
}

function baseSystemPrompt({ scoringLabel, webSearchOn, nowIso }) {
  return `You are Fantasy Edge, BetEdge AI's fantasy football (NFL) analyst. Current time: ${nowIso}. League scoring: ${scoringLabel}.

## Data rules (non-negotiable)
1. Use the tools. Call get_player_report for every player you evaluate before you judge him. Do not rely on memory for injuries, depth charts, roles or recent stats — rosters and injuries change weekly.
2. A player who is not on an injury report is NOT confirmed healthy. If status.label is "STATUS UNCONFIRMED", say his status is unconfirmed and treat it as a risk factor.
3. If sources conflict (status.conflict), say so and name both sources; don't pick one silently.
4. Data marked unavailable (snap share, red-zone splits, anything a tool couldn't fetch) is unknown — say so, never invent numbers.
5. ${webSearchOn ? "web_search is available for news newer than the feeds (practice reports, coach comments, role changes). Prefer official team/NFL sources and established outlets (ESPN, The Athletic, AP, NFL.com, CBS, Yahoo, Pro Football Talk); avoid rumor accounts and fantasy content farms." : "Web search is unavailable right now — rely on the tools and say plainly when something couldn't be verified."}
6. Label facts as facts and judgment as judgment. Never guarantee outcomes.
7. Use fantasy points in ${scoringLabel} scoring (recentGames already has them).

${EDGE_RUBRIC}`;
}

// ---- Model loop ------------------------------------------------------------

async function runFantasyAI({ system, userContent, state, expectJson = true, maxTokens = 6000 }) {
  let webSearchOn = WEB_SEARCH_ENABLED;
  const runTool = makeToolRunner(state);
  const messages = [{ role: "user", content: userContent }];
  let data = null;
  let rounds = 0;
  while (rounds < MAX_TOOL_ROUNDS) {
    rounds++;
    const tools = webSearchOn ? [...TOOLS, { type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: 4 }] : TOOLS;
    try {
      data = await callModelImpl({ model: MODEL, max_tokens: maxTokens, system: system(webSearchOn), tools, messages });
    } catch (err) {
      if (webSearchOn && err.status === 400 && /web_search|server tool|tool type/i.test(err.body || "")) {
        webSearchOn = false;
        rounds--;
        continue;
      }
      throw err;
    }
    for (const b of data.content || []) {
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) state.sources.push({ label: r.title || r.url, url: r.url, kind: "web" });
      }
    }
    messages.push({ role: "assistant", content: data.content });
    if (data.stop_reason === "pause_turn") continue;
    if (data.stop_reason !== "tool_use") break;
    const toolUses = (data.content || []).filter((b) => b.type === "tool_use");
    const results = await Promise.all(
      toolUses.map(async (tu) => {
        try {
          return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(await runTool(tu.name, tu.input)) };
        } catch (err) {
          console.error(`fantasy tool ${tu.name} failed:`, err.message);
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            is_error: true,
            content: JSON.stringify({ status: "unavailable", error: err.message, instruction: "Report this data as unavailable. Do not guess." }),
          };
        }
      })
    );
    messages.push({ role: "user", content: results });
  }

  const finalText = (d) => {
    const content = d?.content || [];
    let lastToolIdx = -1;
    content.forEach((b, i) => {
      if (["tool_use", "server_tool_use", "web_search_tool_result"].includes(b.type)) lastToolIdx = i;
    });
    return content.slice(lastToolIdx + 1).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  };
  // One follow-up call with tools switched off, used when the model ran out of
  // tool rounds, got cut off, or returned text that isn't valid JSON.
  const wrapUp = async (instruction) => {
    const last = messages[messages.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content = [...last.content, { type: "text", text: instruction }];
    else messages.push({ role: "user", content: instruction });
    data = await callModelImpl({
      model: MODEL,
      max_tokens: Math.max(maxTokens, 8000),
      system: system(webSearchOn),
      tools: webSearchOn ? [...TOOLS, { type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: 4 }] : TOOLS,
      tool_choice: { type: "none" },
      messages,
    });
    messages.push({ role: "assistant", content: data.content });
    return finalText(data);
  };
  const JSON_ONLY = expectJson ? " Respond with ONLY the JSON object in the requested shape — no prose, no code fences." : "";

  let text = finalText(data);
  if (data?.stop_reason === "tool_use" || data?.stop_reason === "pause_turn" || !text) {
    // Out of tool rounds: give it one last turn to answer with what it has.
    console.warn(`[fantasy] wrapping up after ${rounds} rounds (stop_reason ${data?.stop_reason})`);
    if (data?.stop_reason === "tool_use") {
      messages.push({
        role: "user",
        content: (data.content || []).filter((b) => b.type === "tool_use").map((tu) => ({
          type: "tool_result",
          tool_use_id: tu.id,
          content: JSON.stringify({ status: "skipped", note: "Tool budget used up. Answer now with the data you already have; call anything missing unavailable." }),
        })),
      });
    }
    text = await wrapUp(`Stop calling tools and give your final answer now using the data you already have.${JSON_ONLY}`);
  } else if (data?.stop_reason === "max_tokens" && expectJson) {
    console.warn("[fantasy] response hit max_tokens; asking for a compact answer");
    text = await wrapUp(`Your last reply was cut off. Give the complete final answer again, more concisely (keep every explanation to one sentence).${JSON_ONLY}`);
  }
  if (!text) throw new Error(`Empty response from model (stop_reason: ${data?.stop_reason})`);
  if (!expectJson) return { text, webSearchOn };
  try {
    return { json: parseJson(text), webSearchOn };
  } catch (err) {
    console.warn(`[fantasy] model JSON didn't parse (${err.message}); asking again`);
    const retry = await wrapUp(`That reply was not valid JSON.${JSON_ONLY}`);
    return { json: parseJson(retry), webSearchOn };
  }
}

export function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = String(text).match(/\{[\s\S]*\}/);
    if (!m) throw new Error("Model did not return JSON.");
    return JSON.parse(m[0]);
  }
}

// ---- Server-side enrichment ------------------------------------------------

function statusSummary(s) {
  if (!s) return { label: "STATUS UNCONFIRMED", confirmed: false, source: null, updated_at: null, note: "Status could not be verified." };
  return {
    label: s.label,
    designation: s.designation,
    confirmed: !!s.confirmed,
    injury: s.injury,
    practiceStatus: s.practiceStatus,
    source: s.source,
    source_url: s.source_url,
    updated_at: s.updated_at,
    retrieved_at: s.retrieved_at,
    conflict: s.conflict,
    note: s.note,
  };
}

// Attaches our own data (team, position, status) to a player object the
// model returned, looking the player up if the model didn't.
async function enrichPlayer(obj, state) {
  if (!obj || !obj.name) return obj;
  let r = state.players.get(norm(obj.name));
  if (!r) {
    r = await getPlayerReport(obj.name, { team: obj.team, scoring: state.scoring }).catch(() => null);
    if (r?.found) state.players.set(norm(obj.name), r);
  }
  const out = { ...obj };
  if (r?.found) {
    out.name = r.player.name;
    out.team = r.player.team;
    out.teamAbbr = r.player.teamAbbr;
    out.position = out.position || r.player.position;
    out.status = statusSummary(r.status);
    out.lastGames = (r.recentGames?.games || []).slice(0, 3).map((g) => ({ opponent: g.opponent, week: g.week, points: g.fantasyPoints }));
    out.upcoming = r.upcomingGame?.status === "ok" ? { opponent: r.upcomingGame.opponent, kickoff: r.upcomingGame.kickoff, homeAway: r.upcomingGame.homeAway } : null;
  } else {
    out.status = statusSummary(null);
    out.unresolved = true;
  }
  if (obj.components) out.edge = computeEdgeScore(obj.components, out.status);
  return out;
}

async function enrichList(list, state) {
  return Promise.all((Array.isArray(list) ? list : []).map((p) => enrichPlayer(p, state)));
}

function dedupeSources(sources) {
  const seen = new Map();
  for (const s of sources) {
    const k = s.url || s.label;
    if (!seen.has(k)) seen.set(k, s);
  }
  return [...seen.values()].slice(0, 12);
}

function newState(body) {
  const scoring = normalizeScoring(body?.scoring);
  return { scoring, scoringLabel: SCORING[scoring].label, players: new Map(), sources: [], position: body?.position };
}

function cleanNames(list, max) {
  return (Array.isArray(list) ? list : [])
    .map((x) => (typeof x === "string" ? x : x?.name))
    .map((s) => String(s || "").trim())
    .filter(Boolean)
    .slice(0, max);
}

function cleanRoster(list) {
  return (Array.isArray(list) ? list : [])
    .map((p) => (typeof p === "string" ? { name: p } : p))
    .filter((p) => p && p.name)
    .slice(0, 25)
    .map((p) => ({
      name: String(p.name).trim(),
      position: p.position ? String(p.position).toUpperCase() : null,
      team: p.team || null,
      slot: p.slot === "bench" || p.slot === "ir" ? p.slot : p.slot === "starter" ? "starter" : null,
      lineupSlot: p.lineupSlot || null,
      projected: Number.isFinite(Number(p.projected)) ? Number(p.projected) : null,
    }));
}

const COMPONENTS_SHAPE = `"components": { "usage": 0-10, "matchup": 0-10, "opportunity": 0-10, "injury": 0-10, "trend": 0-10, "gameEnvironment": 0-10, "roleSecurity": 0-10, "redZone": 0-10, "schedule": 0-10 }`;

function respond(res, state, payload, webSearchOn) {
  res.json({
    ...payload,
    scoring: state.scoringLabel,
    sources: dedupeSources(state.sources),
    webSearchAvailable: webSearchOn,
    answeredAt: new Date().toISOString(),
  });
}

function fail(res, err, what) {
  console.error(`fantasy ${what} failed:`, err);
  const pp = typeof providerProblem === "function" ? providerProblem(err) : null;
  if (pp) return res.status(pp.status).json({ error: pp.error, code: pp.code });
  res.status(502).json({ error: `Fantasy Edge couldn't finish the ${what} right now. Please try again.`, detail: err.message });
}

// Every account (including Free) can use Fantasy Edge, with a daily cap per
// plan (tierService LIMITS.fantasy). Screenshot reading needs a login but
// doesn't count against the cap, so a multi-screenshot roster upload doesn't
// burn a Free user's analyses.
const gate = [withTier, dailyLimit("fantasy")];
const loginGate = [withTier, (req, res, next) =>
  req.user ? next() : res.status(402).json({ error: "Log in or create a free account to use Fantasy Edge.", requiredTier: "standard", loggedIn: false })];

// ---- Start/Sit -------------------------------------------------------------

router.post("/start-sit", ...gate, async (req, res) => {
  const players = cleanNames(req.body?.players, 4);
  if (players.length < 2) return res.status(400).json({ error: "Enter 2 to 4 players to compare." });
  const state = newState(req.body);
  try {
    const nowIso = new Date().toISOString();
    const { json, webSearchOn } = await runFantasyAI({
      state,
      system: (ws) =>
        baseSystemPrompt({ scoringLabel: state.scoringLabel, webSearchOn: ws, nowIso }) +
        `

## Task: START/SIT
Compare the players and pick exactly ONE to start. Return ONLY JSON:
{
  "start": "exact player name to start",
  "players": [
    { "name": string, ${COMPONENTS_SHAPE},
      "tags": [up to 3 short strengths like "High Target Share"],
      "upside": string, "floor": string, "risks": [string], "injuryConcerns": string,
      "matchup": string }
  ],
  "why": "3-5 sentences on why the starter has the edge, citing specific data"
}`,
      userContent: `Players: ${players.join(" vs ")}. Scoring: ${state.scoringLabel}.${req.body?.notes ? ` Notes from user: ${String(req.body.notes).slice(0, 500)}` : ""}`,
    });
    const list = await enrichList(json.players, state);
    list.sort((a, b) => (b.edge?.score ?? -1) - (a.edge?.score ?? -1));
    const start = list.find((p) => norm(p.name) === norm(json.start)) || list[0] || null;
    respond(res, state, { start: start?.name || json.start, players: list, why: json.why || "" }, webSearchOn);
  } catch (err) {
    fail(res, err, "start/sit analysis");
  }
});

// ---- Waiver Edge -------------------------------------------------------------

router.post("/waiver", ...gate, async (req, res) => {
  const position = ["QB", "RB", "WR", "TE", "DEF", "K", "ALL"].includes(String(req.body?.position || "ALL").toUpperCase())
    ? String(req.body?.position || "ALL").toUpperCase()
    : "ALL";
  const available = cleanNames(req.body?.available, 40);
  const roster = cleanRoster(req.body?.roster);
  const state = newState({ ...req.body, position });
  try {
    const nowIso = new Date().toISOString();
    const { json, webSearchOn } = await runFantasyAI({
      state,
      system: (ws) =>
        baseSystemPrompt({ scoringLabel: state.scoringLabel, webSearchOn: ws, nowIso }) +
        `

## Task: WAIVER EDGE
Recommend up to 6 waiver targets${position !== "ALL" ? ` at ${position}` : ""}. ${
          ["DEF", "K"].includes(position)
            ? "For DEF/K, base picks on upcoming opponent, game total/spread and weather from get_team_context; say clearly that player-level usage data doesn't apply."
            : "Start from get_waiver_opportunities (injured starters → next man up), then verify each candidate with get_player_report. Look for: injured starter creating opportunity, rising targets/touches, new starting role, favorable matchup, breakout trends."
        }
${available.length ? "Only recommend players from the user's AVAILABLE list." : "You don't know the user's league — say targets may already be rostered."}
Avoid players already on the user's roster.
Return ONLY JSON:
{
  "targets": [
    { "name": string, "position": string, ${COMPONENTS_SHAPE},
      "opportunity": "short phrase, e.g. 'Starter out — lead back role'",
      "matchup": "short phrase", "whyAdd": "2-3 sentences with specific data",
      "faab": "recommended % of budget, e.g. '12–18%'" }
  ],
  "summary": "1-2 sentences"
}`,
      userContent: `Position: ${position}. Scoring: ${state.scoringLabel}.${available.length ? `\nAVAILABLE in my league: ${available.join(", ")}` : ""}${roster.length ? `\nMY ROSTER: ${roster.map((p) => p.name).join(", ")}` : ""}`,
    });
    const targets = await enrichList(json.targets, state);
    targets.sort((a, b) => (b.edge?.score ?? -1) - (a.edge?.score ?? -1));
    respond(res, state, { position, targets, summary: json.summary || "" }, webSearchOn);
  } catch (err) {
    fail(res, err, "waiver analysis");
  }
});

// ---- Lineup Optimizer -------------------------------------------------------

// A full imported roster is 15+ players. Asking the model to call
// get_player_report for each one blew through the tool-round budget, so the
// server fetches every report in parallel and hands the model a compact
// summary. The tools stay available for anything extra.
async function prefetchReports(roster, state, limit = 6) {
  const todo = roster.filter((p) => p.position !== "DEF" && p.position !== "DST");
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const p = todo[i++];
      try {
        const r = await getPlayerReport(p.name, { team: p.team || undefined, position: p.position || undefined, scoring: state.scoring });
        p.report = r;
        if (r.found) {
          state.players.set(norm(r.player.name), r);
          state.players.set(norm(p.name), r);
          if (r.status?.source) state.sources.push({ label: `${r.status.source} injury report — ${r.player.team}`, url: r.status.source_url, retrieved_at: r.status.retrieved_at, kind: "data" });
        }
      } catch (err) {
        p.report = { found: false, error: err.message };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, todo.length) }, worker));
}

function compactReport(p) {
  const r = p.report;
  if (!r) return p.position === "DEF" || p.position === "DST" ? { note: "Team defense — no player report." } : { status: "not fetched" };
  if (!r.found) return { found: false, status: "STATUS UNCONFIRMED", note: r.error || "Player could not be identified.", candidates: r.candidates };
  const g = r.upcomingGame || {};
  const d = r.opponentDefense || {};
  const { source: _s, retrieved_at: _r, ...def } = d;
  return {
    player: `${r.player.name} (${r.player.position}, ${r.player.teamAbbr})`,
    status: { label: r.status?.label, designation: r.status?.designation, practice: r.status?.practiceStatus, injury: r.status?.injury, source: r.status?.source, updated_at: r.status?.updated_at, conflict: r.status?.conflict || undefined },
    depthRank: r.depthChart?.rank ?? null,
    depthOrder: r.depthChart?.order,
    lastGames: (r.recentGames?.games || []).slice(0, 5).map((x) => `${x.opponent || "?"} ${x.fantasyPoints}`),
    usage: r.usage,
    upcoming: g.status === "ok" ? { opponent: g.opponent, homeAway: g.homeAway, kickoff: g.kickoff, spread: g.spread, total: g.total, weather: g.weather } : { status: g.status || "unavailable" },
    opponentDefense: def,
  };
}

router.post("/lineup", ...gate, async (req, res) => {
  const roster = cleanRoster(req.body?.roster);
  if (roster.length < 3) return res.status(400).json({ error: "Add your roster first (type players or upload a screenshot)." });
  console.log(`[fantasy lineup] roster received (${roster.length}): ${roster.map((p) => `${p.name}[${p.slot || "?"}]`).join(", ")}`);
  const slots = String(req.body?.lineupSlots || "QB, RB, RB, WR, WR, TE, FLEX (RB/WR/TE), K, DEF").slice(0, 200);
  const state = newState(req.body);
  try {
    const t0 = Date.now();
    await prefetchReports(roster, state);
    console.log(`[fantasy lineup] prefetched ${roster.filter((p) => p.report?.found).length}/${roster.length} reports in ${Date.now() - t0}ms`);
    const nowIso = new Date().toISOString();
    const { json, webSearchOn } = await runFantasyAI({
      state,
      maxTokens: 10000,
      system: (ws) =>
        baseSystemPrompt({ scoringLabel: state.scoringLabel, webSearchOn: ws, nowIso }) +
        `

## Task: LINEUP OPTIMIZER
Lineup slots: ${slots}. Each roster player below already comes with his current player report (status, depth chart, recent games, usage, upcoming game, opponent defense) — this counts as having called get_player_report for him. Only call a tool if something important is missing, and use web_search sparingly (at most 2 searches, for the most uncertain statuses). Build the strongest legal lineup for these slots. Never start a player whose designation is Out/IR/Suspended. Players the user marked as starters are the CURRENT lineup (if none are marked, treat the current lineup as unknown and set "current" to []).
Keep every "why" to one or two sentences.
Return ONLY JSON:
{
  "current": [ { "slot": "QB", "name": string } ],
  "optimized": [ { "slot": "QB", "name": string, ${COMPONENTS_SHAPE} } ],
  "changes": [ { "bench": "player to bench", "start": "player to start", "slot": string, "why": "1-2 sentences with data" } ],
  "summary": "2-3 sentences"
}`,
      userContent: `Scoring: ${state.scoringLabel}. My roster:\n${roster
        .map(
          (p) =>
            `- ${p.name}${p.position ? ` (${p.position}${p.team ? `, ${p.team}` : ""})` : ""}${p.slot ? ` [${p.slot}${p.lineupSlot ? ` ${p.lineupSlot}` : ""}]` : ""}${p.projected != null ? ` proj ${p.projected}` : ""}\n  report: ${JSON.stringify(compactReport(p))}`
        )
        .join("\n")}`,
    });
    console.log(`[fantasy lineup] done in ${Date.now() - t0}ms`);
    const optimized = await enrichList(json.optimized, state);
    const current = await enrichList(json.current, state);
    respond(res, state, { current, optimized, changes: Array.isArray(json.changes) ? json.changes : [], summary: json.summary || "" }, webSearchOn);
  } catch (err) {
    fail(res, err, "lineup optimization");
  }
});

// ---- Injury Impact ----------------------------------------------------------

router.post("/injury-impact", ...gate, async (req, res) => {
  const name = String(req.body?.player || "").trim();
  if (!name) return res.status(400).json({ error: "Enter the injured player's name." });
  const state = newState(req.body);
  try {
    const nowIso = new Date().toISOString();
    const { json, webSearchOn } = await runFantasyAI({
      state,
      system: (ws) =>
        baseSystemPrompt({ scoringLabel: state.scoringLabel, webSearchOn: ws, nowIso }) +
        `

## Task: INJURY IMPACT
Look up the injured player with get_player_report, then his team with get_team_context, then get_player_report for each teammate who could gain or lose work. Explain the fantasy ripple effect. If his current status can't be verified, say so — analyze the scenario "if he misses time" and make that explicit.
Return ONLY JSON:
{
  "player": "exact name",
  "scenario": "e.g. 'Listed OUT — analysis assumes he misses this week' or 'Status unconfirmed — impact if he sits'",
  "impacts": [ { "name": string, "position": string, "direction": "up" | "down", "level": "HIGH" | "MEDIUM" | "LOW", "why": "1-2 sentences" } ],
  "effects": { "carries": string, "targets": string, "snapShare": string, "redZone": string, "projection": string, "depthChart": string },
  "summary": "2-3 sentences"
}`,
      userContent: `Injured player: ${name}. Scoring: ${state.scoringLabel}.`,
    });
    const [player] = await enrichList([{ name: json.player || name }], state);
    const impacts = await enrichList(json.impacts, state);
    respond(res, state, { player, scenario: json.scenario || "", impacts, effects: json.effects || {}, summary: json.summary || "" }, webSearchOn);
  } catch (err) {
    fail(res, err, "injury impact analysis");
  }
});

// ---- Trade Analyzer ---------------------------------------------------------

router.post("/trade", ...gate, async (req, res) => {
  const aGives = cleanNames(req.body?.teamAGives, 5);
  const bGives = cleanNames(req.body?.teamBGives, 5);
  if (!aGives.length || !bGives.length) return res.status(400).json({ error: "Add at least one player on each side of the trade." });
  const roster = cleanRoster(req.body?.roster);
  const state = newState(req.body);
  try {
    const nowIso = new Date().toISOString();
    const { json, webSearchOn } = await runFantasyAI({
      state,
      system: (ws) =>
        baseSystemPrompt({ scoringLabel: state.scoringLabel, webSearchOn: ws, nowIso }) +
        `

## Task: TRADE ANALYZER
Look up every player with get_player_report. Judge rest-of-season value, not just this week: usage, role security, injury risk, schedule, recent trend, team depth, position scarcity and the scoring format. Don't decide from projected points alone. Team A is the user unless they say otherwise.
Return ONLY JSON:
{
  "sideA": { "gives": [names], "valueScore": 0-100, "analysis": "2-4 sentences" },
  "sideB": { "gives": [names], "valueScore": 0-100, "analysis": "2-4 sentences" },
  "verdict": "A" | "B" | "EVEN",
  "verdictText": "one sentence, e.g. 'Team A wins this trade' ",
  "tradeoffs": [string],
  "players": [ { "name": string, ${COMPONENTS_SHAPE}, "note": "1 sentence" } ],
  "summary": "2-3 sentences"
}
valueScore = how much rest-of-season value that side RECEIVES (0-100).`,
      userContent: `Team A gives: ${aGives.join(", ")}\nTeam B gives: ${bGives.join(", ")}\nScoring: ${state.scoringLabel}${roster.length ? `\nTeam A's roster: ${roster.map((p) => p.name).join(", ")}` : ""}`,
    });
    const players = await enrichList(json.players, state);
    respond(
      res,
      state,
      {
        sideA: { gives: aGives, valueScore: json.sideA?.valueScore ?? null, analysis: json.sideA?.analysis || "" },
        sideB: { gives: bGives, valueScore: json.sideB?.valueScore ?? null, analysis: json.sideB?.analysis || "" },
        verdict: ["A", "B", "EVEN"].includes(json.verdict) ? json.verdict : "EVEN",
        verdictText: json.verdictText || "",
        tradeoffs: Array.isArray(json.tradeoffs) ? json.tradeoffs : [],
        players,
        summary: json.summary || "",
      },
      webSearchOn
    );
  } catch (err) {
    fail(res, err, "trade analysis");
  }
});

// ---- Fantasy AI Chat ----------------------------------------------------------

router.post("/chat", ...gate, async (req, res) => {
  const message = String(req.body?.message || "").trim();
  if (!message) return res.status(400).json({ error: "Ask a question." });
  const roster = cleanRoster(req.body?.roster);
  const history = (Array.isArray(req.body?.history) ? req.body.history : [])
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.text)
    .slice(-6);
  const state = newState(req.body);
  try {
    const nowIso = new Date().toISOString();
    const convo = history.map((m) => `${m.role === "user" ? "User" : "Fantasy Edge"}: ${String(m.text).slice(0, 1500)}`).join("\n");
    const { text, webSearchOn } = await runFantasyAI({
      state,
      expectJson: false,
      maxTokens: 4096,
      system: (ws) =>
        baseSystemPrompt({ scoringLabel: state.scoringLabel, webSearchOn: ws, nowIso }) +
        `

## Task: FANTASY CHAT
Answer the user's fantasy question conversationally and directly (lead with the answer, then the reasons). Keep it under ~200 words unless they ask for more. Mention each player's injury status with its source and time when it matters. When you rate a player, you may give a rough Edge Score (0-100) using the rubric. Plain text, short paragraphs or simple dashes; no markdown tables.`,
      userContent: `${roster.length ? `MY ROSTER (from my league):\n${roster.map((p) => `- ${p.name}${p.position ? ` (${p.position})` : ""}${p.slot ? ` [${p.slot}]` : ""}`).join("\n")}\n\n` : ""}${convo ? `EARLIER IN THIS CHAT:\n${convo}\n\n` : ""}QUESTION: ${message}`,
    });
    const statuses = [];
    for (const r of new Set(state.players.values())) {
      if (r?.found) statuses.push({ name: r.player.name, team: r.player.teamAbbr, position: r.player.position, status: statusSummary(r.status) });
    }
    respond(res, state, { reply: text, players: statuses }, webSearchOn);
  } catch (err) {
    fail(res, err, "chat answer");
  }
});

// ---- Screenshot → roster ------------------------------------------------------

const MAX_IMAGE_BASE64_CHARS = 12_000_000;
function parseImageDataUrl(raw) {
  if (typeof raw !== "string") return null;
  const m = /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,(.+)$/s.exec(raw.trim());
  if (!m) return null;
  return { mediaType: m[1] === "image/jpg" ? "image/jpeg" : m[1], data: m[2] };
}

// Vision extraction for one or more screenshots of the SAME roster (a full
// roster often needs 2+ screenshots, and the browser also splits very tall
// screenshots into overlapping tiles). All images go to the model in ONE
// request, in order, so it can carry section headings ("Active Players",
// "Reserve Players", "Bench", "IR") across images and skip the overlap.
const ROSTER_VISION_PROMPT = `You read fantasy football screenshots (CBS, ESPN, Yahoo, Sleeper, NFL Fantasy, others) and extract the user's roster exactly as shown. The images are consecutive screenshots/tiles of ONE roster, in order, and they may overlap.

Rules:
- Ignore everything that isn't a roster row: phone status bar, browser/app chrome, tabs, navigation, ads, logos, projections headers, opponent rankings, game times, weather icons.
- Section headings decide the slot for the rows BELOW them, and carry over into the next image until a new heading appears:
  "Active Players", "Starters", "Lineup" -> "starter"; "Reserve Players", "Bench", "BN" -> "bench"; "Injured Reserve", "IR" -> "ir".
  If a row's slot label is BN it's bench; IR is ir. If there is no heading or slot label at all, use null.
- A player that appears in two images (overlap) must be listed ONCE.
- Copy names exactly as displayed (e.g. "A. St. Brown", "C. Godwin"); never invent or expand names you can't see. Team defenses: name them like "Saints" with position "DEF".
- position = the player's own position badge (QB/RB/WR/TE/K/DEF), NOT the lineup slot. lineupSlot = the slot label on the left (QB, RB, WR, TE, FLEX, W/R/T, RWT, K, DST, BN, IR) or null.
- team = the NFL team abbreviation shown next to the player (e.g. DET, NYJ), or null.
- confidence = 0 to 1, how sure you are you read the name correctly.
- Only the user's own team. If a screen shows two teams (a matchup), only include the user's side.

Return ONLY JSON:
{
  "platform": "CBS" | "ESPN" | "Yahoo" | "Sleeper" | "NFL" | "Other" | "Unknown",
  "screenType": "roster" | "matchup" | "waiver" | "trade" | "other",
  "teamName": string | null,
  "players": [ { "name": string, "position": "QB"|"RB"|"WR"|"TE"|"K"|"DEF"|null, "team": string|null,
                 "slot": "starter"|"bench"|"ir"|null, "lineupSlot": string|null, "projected": number|null,
                 "status": "injury tag shown (Q, O, IR, D) or null", "confidence": number } ],
  "unreadable": "anything you couldn't read, or null"
}`;

// Friendly handling for problems with the AI provider account itself
// (e.g. out of API credits), which otherwise look like "bad screenshots".
function providerProblem(err) {
  const body = String(err?.body || err?.message || "");
  if (/credit balance is too low|billing|insufficient.*credit/i.test(body)) {
    return { status: 503, error: "Fantasy Edge's AI is temporarily unavailable (the AI service account needs attention). Please try again later.", code: "ai_billing" };
  }
  if (err?.status === 429 || /rate.?limit|overloaded/i.test(body)) {
    return { status: 503, error: "Fantasy Edge is busy right now. Please try again in a minute.", code: "ai_busy" };
  }
  return null;
}

let screenshotSeq = 0;

export async function extractRosterFromImages(images, { log = () => {} } = {}) {
  log("images received", images.map((im, i) => `#${i + 1} ${im.mediaType} ${Math.round((im.data.length * 3) / 4 / 1024)}KB`).join(", "));
  const content = [];
  images.forEach((im, i) => {
    content.push({ type: "text", text: `Image ${i + 1} of ${images.length}:` });
    content.push({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } });
  });
  content.push({ type: "text", text: "Extract the fantasy roster from these images (one roster, in order, possibly overlapping)." });
  const data = await callModelImpl({ model: MODEL, max_tokens: 4000, system: ROSTER_VISION_PROMPT, messages: [{ role: "user", content }] });
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  const parsed = parseJson(text);
  const rawPlayers = Array.isArray(parsed.players) ? parsed.players : [];
  log("vision output", `${rawPlayers.length} rows (platform ${parsed.platform || "?"}): ` + rawPlayers.map((p) => `${p.name}|${p.position || "-"}|${p.team || "-"}|${p.slot || "-"}|${p.confidence ?? "-"}`).join("; "));

  // Dedupe (the model is told to, but overlap is the #1 source of repeats).
  const seen = new Map();
  for (const p of rawPlayers) {
    if (!p || !p.name) continue;
    const key = normalizeQueryName(p.name).replace(/ /g, "");
    const prev = seen.get(key);
    if (!prev) seen.set(key, p);
    else for (const k of ["position", "team", "slot", "lineupSlot", "projected", "status"]) if (prev[k] == null && p[k] != null) prev[k] = p[k];
  }
  const deduped = [...seen.values()].slice(0, 30);
  log("normalized names", deduped.map((p) => `${p.name} -> ${normalizeQueryName(p.name)}`).join("; "));

  const players = await Promise.all(
    deduped.map(async (p) => {
      const position = p.position ? String(p.position).toUpperCase() : null;
      const base = {
        name: String(p.name).trim(),
        screenshotName: String(p.name).trim(),
        position,
        team: p.team ? String(p.team).toUpperCase() : null,
        slot: ["starter", "bench", "ir"].includes(p.slot) ? p.slot : null,
        lineupSlot: p.lineupSlot || null,
        projected: Number.isFinite(Number(p.projected)) ? Number(p.projected) : null,
        screenshotStatus: p.status || null,
        confidence: Number.isFinite(Number(p.confidence)) ? Number(p.confidence) : null,
      };
      if (position === "DEF") return { ...base, matched: true, kind: "defense" };
      const f = await findPlayer(base.name, { team: base.team, position: position || undefined }).catch((err) => ({ player: null, error: err.message }));
      if (f.player) {
        return { ...base, name: f.player.name, team: f.player.teamAbbr, position: position || f.player.position, playerId: f.player.espnId, matched: true };
      }
      // Fallback: keep the recognized name so analysis can still use it.
      return { ...base, matched: false, needsConfirmation: true, candidates: (f.candidates || []).map((c) => ({ name: c.name, team: c.teamAbbr, position: c.position })), matchError: f.error || null };
    })
  );
  const byId = new Set();
  for (let i = players.length - 1; i >= 0; i--) {
    const pid = players[i].playerId;
    if (!pid) continue;
    if (byId.has(pid)) players.splice(i, 1);
    else byId.add(pid);
  }
  log("matched", players.filter((p) => p.matched).map((p) => `${p.screenshotName} => ${p.name}${p.playerId ? ` (#${p.playerId})` : ""}`).join("; ") || "none");
  log("unmatched", players.filter((p) => !p.matched).map((p) => `${p.screenshotName}${p.matchError ? ` (${p.matchError})` : ""}`).join("; ") || "none");
  return { platform: parsed.platform || "Unknown", screenType: parsed.screenType || "roster", teamName: parsed.teamName || null, players, unreadable: parsed.unreadable || null };
}

async function handleScreenshots(req, res, images) {
  const id = `ss${++screenshotSeq}-${Date.now().toString(36)}`;
  const log = (stage, detail) => console.log(`[fantasy screenshot ${id}] ${stage}: ${detail}`);
  try {
    const out = await extractRosterFromImages(images, { log });
    log("final roster", out.players.map((p) => `${p.name}[${p.slot || "?"}]`).join(", ") || "EMPTY");
    res.json({
      ...out,
      imageCount: images.length,
      note: "Injury tags shown in your app's screenshot are only as current as the screenshot — Fantasy Edge re-checks live status when it analyzes these players.",
    });
  } catch (err) {
    log("FAILED", err.message);
    const pp = providerProblem(err);
    if (pp) return res.status(pp.status).json({ error: pp.error, code: pp.code });
    fail(res, err, "screenshot scan");
  }
}

// POST /api/fantasy/screenshots { images: [dataUrl, ...] } — one roster from up to 10 images/tiles.
router.post("/screenshots", ...loginGate, async (req, res) => {
  const list = Array.isArray(req.body?.images) ? req.body.images.slice(0, 10) : [];
  const images = list.map(parseImageDataUrl);
  if (!images.length || images.some((im) => !im)) return res.status(400).json({ error: "Upload PNG, JPG or WebP screenshots." });
  const total = images.reduce((n, im) => n + im.data.length, 0);
  if (images.some((im) => im.data.length > MAX_IMAGE_BASE64_CHARS) || total > MAX_IMAGE_BASE64_CHARS * 1.5) {
    return res.status(400).json({ error: "Those images are too large — try fewer screenshots at a time." });
  }
  return handleScreenshots(req, res, images);
});

// POST /api/fantasy/screenshot { image } — single image (kept for older clients).
router.post("/screenshot", ...loginGate, async (req, res) => {
  const img = parseImageDataUrl(req.body?.image);
  if (!img) return res.status(400).json({ error: "Upload a PNG, JPG or WebP screenshot." });
  if (img.data.length > MAX_IMAGE_BASE64_CHARS) return res.status(400).json({ error: "That image is too large." });
  return handleScreenshots(req, res, [img]);
});

// ---- Player search (autocomplete) --------------------------------------------
// Public and cheap: served from the cached roster index.
router.get("/players/search", async (req, res) => {
  try {
    res.json({ players: await searchPlayers(String(req.query.q || ""), { limit: 8 }) });
  } catch (err) {
    console.error("fantasy player search failed:", err.message);
    res.json({ players: [], error: "Player search is unavailable right now." });
  }
});

// ---- Quick status lookup (for cards) -------------------------------------------

router.get("/player-status", ...loginGate, async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  try {
    const r = await getPlayerReport(name, { team: req.query.team, scoring: req.query.scoring });
    if (!r.found) return res.json({ found: false, error: r.error, candidates: r.candidates, status: statusSummary(null) });
    res.json({ found: true, player: r.player, status: statusSummary(r.status), depthChart: r.depthChart, upcomingGame: r.upcomingGame });
  } catch (err) {
    fail(res, err, "status lookup");
  }
});

export { playerInjuryStatus };
export default router;
