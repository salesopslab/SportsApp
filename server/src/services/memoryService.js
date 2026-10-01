import { pool, ensureSchema } from "../db.js";

// Long-term memory for BetEdge AI, per logged-in user.
//
// - A short profile (teams/sports followed, bet types, stake sizes, answer
//   preferences, things they asked it to remember) is rewritten in the
//   background every few chats from the user's recent questions, by one
//   small model call. It never blocks an answer.
// - The chat also sees the user's last few questions from earlier sessions.
// - Users can view it and clear it ("Forget everything"); clearing also
//   hides older chats from future memory updates.
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const MEMORY_MODEL = process.env.MEMORY_MODEL || process.env.CHAT_MODEL || "claude-sonnet-5";
const UPDATE_EVERY = Number(process.env.MEMORY_UPDATE_EVERY || 3);
const MAX_PROFILE_CHARS = 1500;

let callModelImpl = async (body) => {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Anthropic API error ${r.status}: ${await r.text()}`);
  return r.json();
};
export function __setMemoryModelCaller(fn) { fn.__test = true; callModelImpl = fn; }

async function row(userId) {
  const { rows } = await pool.query("SELECT profile, chats_since_update, cleared_at, updated_at FROM user_ai_memory WHERE user_id = $1", [userId]);
  return rows[0] || null;
}

// What the chat gets for this user: { profile, recent: [{at, question, game}] }.
export async function getMemoryForChat(userId) {
  if (!pool || !userId) return null;
  try {
    await ensureSchema();
    const m = await row(userId);
    const { rows } = await pool.query(
      `SELECT created_at, question, game_label FROM chat_logs
        WHERE user_id = $1 AND error IS NULL AND created_at > COALESCE($2, 'epoch'::timestamptz)
        ORDER BY created_at DESC LIMIT 6`,
      [userId, m?.cleared_at || null]
    );
    const recent = rows.map((r) => ({ at: r.created_at, question: r.question.slice(0, 300), game: r.game_label || null }));
    if (!m?.profile && !recent.length) return null;
    return { profile: m?.profile || null, updatedAt: m?.updated_at || null, recent };
  } catch (err) {
    console.error("getMemoryForChat failed:", err.message);
    return null;
  }
}

export async function clearMemory(userId) {
  if (!pool) return;
  await ensureSchema();
  await pool.query(
    `INSERT INTO user_ai_memory (user_id, profile, chats_since_update, cleared_at, updated_at)
     VALUES ($1, NULL, 0, now(), now())
     ON CONFLICT (user_id) DO UPDATE SET profile = NULL, chats_since_update = 0, cleared_at = now(), updated_at = now()`,
    [userId]
  );
}

// Called after every answered chat (fire-and-forget).
export async function noteChatForMemory(userId) {
  if (!pool || !userId || !ANTHROPIC_KEY && !callModelImpl.__test) return;
  try {
    await ensureSchema();
    const { rows } = await pool.query(
      `INSERT INTO user_ai_memory (user_id, chats_since_update) VALUES ($1, 1)
       ON CONFLICT (user_id) DO UPDATE SET chats_since_update = user_ai_memory.chats_since_update + 1
       RETURNING profile, chats_since_update, cleared_at`,
      [userId]
    );
    const m = rows[0];
    // First memory after 1 chat, then every few chats.
    if (m.profile ? m.chats_since_update >= UPDATE_EVERY : m.chats_since_update >= 1) await updateMemory(userId, m);
  } catch (err) {
    console.error("memory update failed:", err.message);
  }
}

export const MEMORY_PROMPT = `You maintain a short memory profile of one BetEdge AI user (a sports-betting research app), so future answers can be personalized. You get their current profile (may be empty) and their recent questions (newest first) with short excerpts of the answers.

Write the updated profile as at most 10 short bullet lines, under ${MAX_PROFILE_CHARS} characters, covering only what the user actually said or clearly showed:
- Sports, leagues and teams they follow or bet on
- Bet types they use (spreads, moneylines, totals, parlays, props, teasers) and typical stake/unit size if stated
- How they like answers (short vs. detailed, wants web news, wants Pass calls, etc.)
- Fantasy football context if any (league scoring, key players)
- Anything they explicitly asked to be remembered
- Current focus (e.g. "Week 5 NFL slate", dated) — drop items that are clearly stale

Rules: facts from the user only, never invented; no guessing about income, location, health or other personal details; don't record specific answers or picks the AI gave; merge with the existing profile and drop anything contradicted. If there is nothing worth remembering, return the existing profile unchanged (or "(nothing yet)"). Output ONLY the bullet lines.`;

async function updateMemory(userId, m) {
  const { rows } = await pool.query(
    `SELECT created_at, question, reply, game_label FROM chat_logs
      WHERE user_id = $1 AND error IS NULL AND created_at > COALESCE($2, 'epoch'::timestamptz)
      ORDER BY created_at DESC LIMIT 20`,
    [userId, m.cleared_at || null]
  );
  if (!rows.length) return;
  const recent = rows
    .map((r) => `- [${new Date(r.created_at).toISOString().slice(0, 10)}${r.game_label ? ` · ${r.game_label}` : ""}] Q: ${r.question.slice(0, 500)}\n  A (excerpt): ${(r.reply || "").replace(/\s+/g, " ").slice(0, 240)}`)
    .join("\n");
  const data = await callModelImpl({
    model: MEMORY_MODEL,
    max_tokens: 2000,
    system: MEMORY_PROMPT,
    messages: [{ role: "user", content: `CURRENT PROFILE:\n${m.profile || "(empty)"}\n\nRECENT CHATS (newest first):\n${recent}` }],
  });
  let text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text) return;
  if (/^\(nothing yet\)$/i.test(text)) text = null;
  if (text && text.length > MAX_PROFILE_CHARS) text = text.slice(0, MAX_PROFILE_CHARS).replace(/\n[^\n]*$/, "");
  await pool.query("UPDATE user_ai_memory SET profile = $2, chats_since_update = 0, updated_at = now() WHERE user_id = $1", [userId, text]);
}
