// AI chat memory: conversation history + per-user long-term memory.
// Needs a scratch database: TEST_DATABASE_URL=postgres://... (skipped otherwise).
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";

if (!process.env.TEST_DATABASE_URL) {
  console.log("SKIP  memory tests (set TEST_DATABASE_URL to a scratch Postgres database to run them)");
  process.exit(0);
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_SSL = "false";
process.env.JWT_SECRET ||= "test-secret";
process.env.ANTHROPIC_API_KEY ||= "test";
process.env.ODDS_API_KEY ||= "test";
globalThis.fetch = async (url) => { throw new Error(`Unmocked fetch: ${url}`); };

const { pool, ensureSchema } = await import("../src/db.js");
await ensureSchema();
await pool.query("DELETE FROM chat_logs; DELETE FROM user_ai_memory; DELETE FROM users WHERE email = 'mem@test.dev'");
const { rows: [user] } = await pool.query("INSERT INTO users (email, password_hash, tier, trial_ends_at) VALUES ('mem@test.dev','x','edge_pro', now() + interval '3 days') RETURNING id, email");
const { signToken } = await import("../src/services/authService.js");
const token = signToken({ id: user.id, email: user.email });

const chat = await import("../src/routes/chat.js");
const mem = await import("../src/services/memoryService.js");
const calls = [];
chat.__setChatModelCaller(async (body) => { calls.push(body); return { stop_reason: "end_turn", content: [{ type: "text", text: `Answer ${calls.length}.` }] }; });
let memoryCalls = 0;
mem.__setMemoryModelCaller(async (body) => {
  memoryCalls++;
  const sawIt = /1 unit = \$25/.test(body.messages[0].content);
  return { content: [{ type: "text", text: sawIt ? "- Mostly bets NFL totals\n- 1 unit = $25 (asked to remember)" : "(nothing yet)" }] };
});

const app = express();
app.use(express.json());
app.use("/api/chat", chat.default);
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
const call = (method, path, body) => new Promise((resolve, reject) => {
  const r = http.request(base + path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` } }, (res) => {
    let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(b || "{}") }));
  });
  r.on("error", reject); if (body) r.write(JSON.stringify(body)); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
async function test(name, fn) { try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name}\n      ${e.stack}`); } }

await test("conversation history is sent with the question (follow-ups work)", async () => {
  const r = await call("POST", "/api/chat", { message: "What about the total?", history: [
    { role: "user", text: "Who wins Eagles vs Cowboys?" }, { role: "assistant", text: "Lean Eagles -3." }, { role: "user", text: "dangling" },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const msgs = calls.at(-1).messages;
  assert.deepEqual(msgs.slice(0, 3).map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(msgs[1].content, "Lean Eagles -3.");
  assert.equal(msgs[2].content, "What about the total?");
});

await test("a logged-in user's chats build a memory profile in the background", async () => {
  await call("POST", "/api/chat", { message: "I mostly bet NFL totals, 1 unit = $25. Remember that." });
  await wait(400);
  assert.ok(memoryCalls >= 1, "memory model called");
  const r = await call("GET", "/api/chat/memory");
  assert.match(r.json.profile, /NFL totals/);
  assert.ok(r.json.recent.some((q) => /1 unit = \$25/.test(q.question)));
});

await test("the next chat's system prompt includes the profile and earlier questions", async () => {
  await call("POST", "/api/chat", { message: "Any good overs Sunday?" });
  const sys = calls.at(-1).system;
  assert.match(sys, /What you remember about this user/);
  assert.match(sys, /Mostly bets NFL totals/);
  assert.match(sys, /RECENT QUESTIONS FROM EARLIER SESSIONS/);
  assert.match(sys, /picker|Price first/);
});

await test("Forget everything clears the profile and hides older chats", async () => {
  const d = await call("DELETE", "/api/chat/memory");
  assert.equal(d.status, 200);
  const r = await call("GET", "/api/chat/memory");
  assert.equal(r.json.profile, null);
  assert.equal(r.json.recent.length, 0);
  await call("POST", "/api/chat", { message: "hello again" });
  assert.doesNotMatch(calls.at(-1).system, /Mostly bets NFL totals/);
});

await test("every chat is logged with prompt version, tools and timing", async () => {
  await wait(400);
  const { rows } = await pool.query("SELECT * FROM chat_logs WHERE user_id = $1 ORDER BY id", [user.id]);
  assert.ok(rows.length >= 4);
  assert.equal(rows[0].prompt_version, chat.PROMPT_VERSION);
  assert.ok(rows.every((r) => r.response_ms != null && r.model));
});

await wait(300);
server.close();
await pool.end();
if (failures) { console.log(`\n${failures} test(s) failed`); process.exit(1); }
console.log("\nAll memory tests passed");
process.exit(0);
