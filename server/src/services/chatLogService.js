import { pool, ensureSchema } from "../db.js";

// Records each AI chat answer for quality review (GET /api/admin/chat-logs).
// Fire-and-forget: logging can never slow down or break an answer. Without a
// database it writes one JSON line to the server log instead. Keeps 180 days.
const KEEP_DAYS = 180;
let lastPrune = 0;

export function logChat(entry) {
  const row = {
    userId: entry.userId ?? null,
    sport: entry.sport || null,
    gameId: entry.gameId || null,
    gameLabel: entry.gameLabel || null,
    question: String(entry.question || "").slice(0, 4000),
    reply: entry.reply != null ? String(entry.reply).slice(0, 20000) : null,
    error: entry.error ? String(entry.error).slice(0, 2000) : null,
    model: entry.model || null,
    promptVersion: entry.promptVersion || null,
    tools: Array.isArray(entry.tools) ? entry.tools.slice(0, 50) : [],
    usedWebSearch: !!entry.usedWebSearch,
    responseMs: Number.isFinite(entry.responseMs) ? Math.round(entry.responseMs) : null,
  };
  if (!pool) {
    console.log(`[chat-log] ${JSON.stringify({ at: new Date().toISOString(), ...row })}`);
    return Promise.resolve();
  }
  return ensureSchema()
    .then(() =>
      pool.query(
        `INSERT INTO chat_logs (user_id, sport, game_id, game_label, question, reply, error, model, prompt_version, tools, used_web_search, response_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row.userId, row.sport, row.gameId, row.gameLabel, row.question, row.reply, row.error, row.model, row.promptVersion, row.tools, row.usedWebSearch, row.responseMs]
      )
    )
    .then(() => {
      if (Date.now() - lastPrune > 24 * 3600e3) {
        lastPrune = Date.now();
        return pool.query(`DELETE FROM chat_logs WHERE created_at < now() - interval '${KEEP_DAYS} days'`);
      }
    })
    .catch((err) => console.error("chat log write failed:", err.message));
}

export async function listChatLogs({ days = 7, limit = 100, offset = 0, search = "", promptVersion = "" } = {}) {
  if (!pool) return { rows: [], total: 0, note: "No database configured — chat logs are in the server log as [chat-log] lines." };
  await ensureSchema();
  const params = [Math.max(1, Math.min(180, Number(days) || 7))];
  let where = `created_at > now() - ($1 || ' days')::interval`;
  if (search) { params.push(`%${search}%`); where += ` AND (question ILIKE $${params.length} OR reply ILIKE $${params.length} OR game_label ILIKE $${params.length})`; }
  if (promptVersion) { params.push(promptVersion); where += ` AND prompt_version = $${params.length}`; }
  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM chat_logs WHERE ${where}`, params)).rows[0].n;
  params.push(Math.max(1, Math.min(500, Number(limit) || 100)), Math.max(0, Number(offset) || 0));
  const { rows } = await pool.query(
    `SELECT id, created_at, user_id, sport, game_id, game_label, question, reply, error, model, prompt_version, tools, used_web_search, response_ms
       FROM chat_logs WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return { rows, total };
}
