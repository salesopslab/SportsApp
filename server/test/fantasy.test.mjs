// Fantasy Edge integration test: runs the REAL /api/fantasy routes and
// fantasyDataService against mocked upstreams (ESPN, SportsDataIO, The Odds
// API) and a scripted model. Usage: node test/fantasy.test.mjs
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

process.env.ANTHROPIC_API_KEY = "test-key";
process.env.WEB_SEARCH_ENABLED = "false";
process.env.ODDS_API_BASE = "https://api.the-odds-api.com/v4";
delete process.env.DATABASE_URL;

const NOW = Date.now();
const iso = (minsAgo) => new Date(NOW - minsAgo * 60000).toISOString();
let scenario = "normal";

const TEAMS = [
  { team: { id: "28", abbreviation: "WSH", displayName: "Washington Commanders" } },
  { team: { id: "11", abbreviation: "IND", displayName: "Indianapolis Colts" } },
];
const ROSTERS = {
  28: [
    { id: "101", displayName: "Jayden Daniels", position: { abbreviation: "QB" } },
    { id: "102", displayName: "Terry McLaurin", position: { abbreviation: "WR" } },
    { id: "103", displayName: "Noah Brown", position: { abbreviation: "WR" } },
    { id: "104", displayName: "Luke McCaffrey", position: { abbreviation: "WR" } },
    { id: "105", displayName: "Brian Robinson Jr.", position: { abbreviation: "RB" } },
    { id: "106", displayName: "Zach Ertz", position: { abbreviation: "TE" } },
  ],
  11: [
    { id: "201", displayName: "Jonathan Taylor", position: { abbreviation: "RB" } },
    { id: "202", displayName: "Michael Pittman Jr.", position: { abbreviation: "WR" } },
    { id: "203", displayName: "Josh Downs", position: { abbreviation: "WR" } },
  ],
};
const DEPTH = {
  28: {
    depthchart: [
      {
        name: "3WR 1TE",
        positions: {
          qb: { position: { abbreviation: "QB" }, athletes: [{ displayName: "Jayden Daniels" }] },
          rb: { position: { abbreviation: "RB" }, athletes: [{ displayName: "Brian Robinson Jr." }] },
          lwr: { position: { abbreviation: "WR" }, athletes: [{ displayName: "Terry McLaurin" }, { displayName: "Luke McCaffrey" }] },
          rwr: { position: { abbreviation: "WR" }, athletes: [{ displayName: "Noah Brown" }] },
          te: { position: { abbreviation: "TE" }, athletes: [{ displayName: "Zach Ertz" }] },
        },
      },
    ],
  },
  11: {
    depthchart: [
      {
        positions: {
          rb: { position: { abbreviation: "RB" }, athletes: [{ displayName: "Jonathan Taylor" }] },
          wr: { position: { abbreviation: "WR" }, athletes: [{ displayName: "Michael Pittman Jr." }, { displayName: "Josh Downs" }] },
        },
      },
    ],
  },
};
function gamelog(targets) {
  return {
    names: ["receptions", "receivingTargets", "receivingYards", "receivingTouchdowns", "rushingAttempts", "rushingYards", "rushingTouchdowns"],
    seasonTypes: [
      {
        displayName: "2026 Regular Season",
        categories: [
          {
            events: [
              { eventId: "e1", stats: ["6", String(targets), "80", "1", "0", "0", "0"] },
              { eventId: "e2", stats: ["4", String(targets - 2), "50", "0", "0", "0", "0"] },
            ],
          },
        ],
      },
    ],
    events: {
      e1: { week: 3, gameDate: iso(60 * 24 * 7), opponent: { abbreviation: "DAL" }, atVs: "vs" },
      e2: { week: 2, gameDate: iso(60 * 24 * 14), opponent: { abbreviation: "NYG" }, atVs: "@" },
    },
  };
}
function espnInjuries() {
  return {
    timestamp: iso(20),
    injuries: [
      {
        displayName: "Washington Commanders",
        injuries: [
          {
            status: "Questionable",
            date: iso(45),
            shortComment: "Daniels (elbow) was a limited participant in Thursday's practice.",
            athlete: { displayName: "Jayden Daniels", position: { abbreviation: "QB" } },
            details: { type: "Elbow", side: "Left" },
          },
          {
            status: "Out",
            date: iso(60),
            shortComment: "Did not practice.",
            athlete: { displayName: "Terry McLaurin", position: { abbreviation: "WR" } },
            details: { type: "Quad" },
          },
        ],
      },
      { displayName: "Indianapolis Colts", injuries: [] },
    ],
  };
}
const oddsGame = {
  id: "g1",
  sport_key: "americanfootball_nfl",
  commence_time: new Date(NOW + 3 * 86400000).toISOString(),
  home_team: "Washington Commanders",
  away_team: "Indianapolis Colts",
  bookmakers: [
    {
      title: "DraftKings",
      markets: [
        { key: "h2h", outcomes: [{ name: "Washington Commanders", price: -150 }, { name: "Indianapolis Colts", price: 130 }] },
        { key: "spreads", outcomes: [{ name: "Washington Commanders", price: -110, point: -3 }, { name: "Indianapolis Colts", price: -110, point: 3 }] },
        { key: "totals", outcomes: [{ name: "Over", price: -110, point: 47.5 }, { name: "Under", price: -110, point: 47.5 }] },
      ],
    },
  ],
};
const jsonRes = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("espn.com") && u.endsWith("/injuries")) {
    if (scenario === "espn-down") return new Response("blocked", { status: 403 });
    return jsonRes(espnInjuries());
  }
  if (u.includes("site.api.espn.com") && u.endsWith("/nfl/teams")) return jsonRes({ sports: [{ leagues: [{ teams: TEAMS }] }] });
  let m = u.match(/teams\/(\d+)\/roster/);
  if (m) return jsonRes({ athletes: [{ position: "offense", items: ROSTERS[m[1]] || [] }] });
  m = u.match(/teams\/(\d+)\/depthcharts/);
  if (m) return jsonRes(DEPTH[m[1]] || {});
  m = u.match(/athletes\/(\d+)\/gamelog/);
  if (m) return jsonRes(gamelog(m[1] === "103" ? 9 : 7));
  if (u.includes("sportsdata.io") && u.includes("InjuredPlayers")) {
    if (scenario === "espn-down") return new Response("down", { status: 500 });
    return jsonRes([{ Name: "Jayden Daniels", Team: "WAS", Position: "QB", InjuryStatus: "Doubtful", BodyPart: "Elbow" }]);
  }
  if (u.includes("sportsdata.io") && u.includes("TeamSeasonStats")) {
    return jsonRes([
      { Team: "WAS", Games: 3, OpponentPassingYards: 700, OpponentRushingYards: 300, OpponentScore: 60 },
      { Team: "IND", Games: 3, OpponentPassingYards: 800, OpponentRushingYards: 420, OpponentScore: 80 },
    ]);
  }
  if (u.includes("the-odds-api.com") && u.includes("/odds")) return jsonRes([oddsGame]);
  if (u.includes("openweathermap")) return jsonRes({ list: [] });
  throw new Error(`Unmocked fetch: ${u}`);
};

const fantasyMod = await import("../src/routes/fantasy.js");
const data = await import("../src/services/fantasyDataService.js");
const cache = (await import("../src/services/cache.js")).default;
const router = fantasyMod.default;

// Scripted model: first turn asks for a player report per name in the
// request; second turn returns the JSON the route asked for.
let modelScript = null;
const modelCalls = [];
fantasyMod.__setModelCaller(async (body) => {
  modelCalls.push(body);
  return modelScript(body);
});

// Bypass auth/tier for the test (pretend a Standard subscriber).
for (const layer of router.stack) {
  if (!layer.route || layer.route.stack.length < 3) continue;
  layer.route.stack[0].handle = (req, _res, next) => { req.userRow = { tier: "standard" }; req.tier = "standard"; next(); };
  layer.route.stack[1].handle = (_req, _res, next) => next();
}
const app = express();
app.use(express.json({ limit: "15mb" }));
app.use("/api/fantasy", router);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
function local(method, path, body) {
  return new Promise((resolve, reject) => {
    const d = body ? JSON.stringify(body) : null;
    const req = http.request(base + path, { method, headers: { "content-type": "application/json" } }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(buf || "{}") }));
    });
    req.on("error", reject);
    if (d) req.write(d);
    req.end();
  });
}

let failures = 0;
async function test(name, fn) {
  try {
    cache.flushAll();
    scenario = "normal";
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.stack || err.message}`);
  }
}

const comps = (v) => ({ usage: v, matchup: v, opportunity: v, injury: v, trend: v, gameEnvironment: v, roleSecurity: v, redZone: v, schedule: v });
function twoStep(names, finalJson) {
  return (body) => {
    const last = body.messages[body.messages.length - 1];
    const hasToolResult = Array.isArray(last.content) && last.content.some((c) => c.type === "tool_result");
    if (!hasToolResult) {
      return {
        stop_reason: "tool_use",
        content: names.map((n, i) => ({ type: "tool_use", id: `t${i}`, name: "get_player_report", input: { name: n } })),
      };
    }
    return { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(finalJson) }] };
  };
}

await test("Edge Score: fixed weights, labels, and injury caps", () => {
  assert.equal(fantasyMod.computeEdgeScore(comps(10), {}).score, 100);
  assert.equal(fantasyMod.computeEdgeScore(comps(9), {}).label, "ELITE");
  assert.equal(fantasyMod.computeEdgeScore(comps(6), {}).label, "SOLID");
  const out = fantasyMod.computeEdgeScore(comps(10), { designation: "Out" });
  assert.equal(out.label, "OUT");
  assert.ok(out.score <= 5);
  assert.ok(fantasyMod.computeEdgeScore(comps(10), { designation: "Doubtful" }).score <= 25);
});

await test("fantasy points differ by scoring format", () => {
  const s = { receptions: 6, receivingYards: 80, receivingTouchdowns: 1 };
  assert.equal(data.fantasyPoints(s, "ppr"), 20);
  assert.equal(data.fantasyPoints(s, "half"), 17);
  assert.equal(data.fantasyPoints(s, "standard"), 14);
});

await test("depth chart merges split WR slots in order", () => {
  const chart = data.parseDepthChart(DEPTH[28]);
  assert.deepEqual(chart.WR, ["Terry McLaurin", "Noah Brown", "Luke McCaffrey"]);
  assert.deepEqual(chart.QB, ["Jayden Daniels"]);
});

await test("player report: listed player shows designation, source and updated time, with conflict flagged", async () => {
  const r = await data.getPlayerReport("Jayden Daniels");
  assert.ok(r.found);
  assert.equal(r.status.label, "QUESTIONABLE");
  assert.equal(r.status.source, "ESPN");
  assert.ok(r.status.updated_at);
  assert.equal(r.status.practiceStatus, "Limited");
  assert.ok(r.status.conflict, "ESPN Questionable vs SportsDataIO Doubtful should be flagged");
  assert.equal(r.upcomingGame.status, "ok", JSON.stringify(r.upcomingGame));
  assert.equal(r.upcomingGame.opponent, "Indianapolis Colts");
  assert.equal(r.upcomingGame.total.point, 47.5);
});

await test("player NOT on injury report is STATUS UNCONFIRMED, never healthy", async () => {
  const r = await data.getPlayerReport("Noah Brown");
  assert.ok(r.found);
  assert.equal(r.status.label, "STATUS UNCONFIRMED");
  assert.equal(r.status.confirmed, false);
  assert.match(r.status.note, /does not confirm/);
  assert.equal(r.depthChart.rank, 2);
  assert.equal(r.usage.avgTargets, 8);
});

await test("all injury sources down → STATUS UNCONFIRMED with 'could not be retrieved'", async () => {
  scenario = "espn-down";
  const r = await data.getPlayerReport("Jayden Daniels");
  assert.equal(r.status.label, "STATUS UNCONFIRMED");
  assert.match(r.status.note, /could not be retrieved/);
});

await test("start/sit: server attaches live status + computes Edge Score, OUT player can't win", async () => {
  modelScript = twoStep(["Terry McLaurin", "Noah Brown"], {
    start: "Terry McLaurin",
    players: [
      { name: "Terry McLaurin", components: comps(9), tags: ["High Target Share"], upside: "", floor: "", risks: [], injuryConcerns: "", matchup: "" },
      { name: "Noah Brown", components: comps(6), tags: [], upside: "", floor: "", risks: [], injuryConcerns: "", matchup: "" },
    ],
    why: "test",
  });
  const r = await local("POST", "/api/fantasy/start-sit", { players: ["Terry McLaurin", "Noah Brown"], scoring: "half" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const mcl = r.json.players.find((p) => p.name === "Terry McLaurin");
  const brown = r.json.players.find((p) => p.name === "Noah Brown");
  assert.equal(mcl.status.label, "OUT");
  assert.equal(mcl.edge.label, "OUT");
  assert.equal(brown.status.label, "STATUS UNCONFIRMED");
  assert.equal(brown.edge.score, 60);
  assert.equal(r.json.players[0].name, "Noah Brown", "sorted by Edge Score");
  assert.equal(r.json.scoring, "Half PPR");
  const sys = modelCalls[0].system;
  assert.match(sys, /NOT confirmed healthy/);
});

await test("start/sit rejects fewer than 2 players", async () => {
  const r = await local("POST", "/api/fantasy/start-sit", { players: ["Only One"] });
  assert.equal(r.status, 400);
});

await test("waiver opportunities: injured WR1 → next man up on the depth chart", async () => {
  const r = await data.getOpportunityReport({ position: "WR" });
  const w = r.opportunities.find((o) => o.team === "Washington Commanders");
  assert.ok(w, JSON.stringify(r));
  assert.equal(w.injuredStarters[0].name, "Terry McLaurin");
  assert.equal(w.nextUp[0], "Noah Brown");
});

await test("screenshot: extracted names are matched to real players", async () => {
  modelScript = () => ({
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          platform: "Sleeper",
          screenType: "roster",
          players: [
            { name: "J. Daniels", position: "QB", team: "WAS", slot: "starter", lineupSlot: "QB", projected: 21.4, status: "Q" },
            { name: "Noah Brown", position: "WR", slot: "bench", lineupSlot: "BN" },
          ],
        }),
      },
    ],
  });
  const r = await local("POST", "/api/fantasy/screenshot", { image: "data:image/png;base64,iVBORw0KGgo=" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.platform, "Sleeper");
  assert.equal(r.json.players[0].name, "Jayden Daniels");
  assert.equal(r.json.players[0].matched, true);
  assert.equal(r.json.players[1].slot, "bench");
});

await test("unknown player comes back unresolved with STATUS UNCONFIRMED", async () => {
  modelScript = twoStep(["Nobody Realname"], { players: [{ name: "Nobody Realname", components: comps(7) }, { name: "Noah Brown", components: comps(7) }], start: "Noah Brown", why: "" });
  const r = await local("POST", "/api/fantasy/start-sit", { players: ["Nobody Realname", "Noah Brown"] });
  const nobody = r.json.players.find((p) => p.name === "Nobody Realname");
  assert.equal(nobody.unresolved, true);
  assert.equal(nobody.status.label, "STATUS UNCONFIRMED");
});

await test("player search: partial names return real players, roster positions only", async () => {
  const r = await local("GET", "/api/fantasy/players/search?q=jay");
  assert.equal(r.status, 200);
  assert.equal(r.json.players[0].name, "Jayden Daniels");
  assert.equal(r.json.players[0].position, "QB");
  const last = await local("GET", "/api/fantasy/players/search?q=mcl");
  assert.equal(last.json.players[0].name, "Terry McLaurin");
  const none = await local("GET", "/api/fantasy/players/search?q=z");
  assert.deepEqual(none.json.players, []);
});

await test("chat returns reply plus live statuses for players it looked up", async () => {
  modelScript = (body) => {
    const last = body.messages[body.messages.length - 1];
    if (!(Array.isArray(last.content) && last.content.some((c) => c.type === "tool_result"))) {
      return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "c1", name: "get_player_report", input: { name: "Jayden Daniels" } }] };
    }
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Start Daniels, but he's Questionable (ESPN, 45 min ago)." }] };
  };
  const r = await local("POST", "/api/fantasy/chat", { message: "Should I start Daniels?", roster: [{ name: "Jayden Daniels" }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.match(r.json.reply, /Questionable/);
  assert.equal(r.json.players[0].status.label, "QUESTIONABLE");
});

server.close();
if (failures) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log("\nAll fantasy tests passed");
