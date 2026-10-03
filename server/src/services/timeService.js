// Per-user time zone. The app sends the device's IANA zone (e.g.
// "America/Los_Angeles") in an X-Timezone header on every request — the
// phone sets that from where the user actually is, which is more reliable
// than guessing from an IP address (VPNs, carrier networks). Logged-in
// users' zones are saved on their account so anything the server writes
// for them without a live request still has it. Falls back to US Eastern.
import { AsyncLocalStorage } from "node:async_hooks";
import { pool } from "../db.js";
import { verifyToken } from "./authService.js";

export const DEFAULT_TZ = "America/New_York";
const als = new AsyncLocalStorage();
const savedTz = new Map(); // userId -> zone last written/read, so we don't hit the DB every request

export function validTz(tz) {
  if (!tz || typeof tz !== "string" || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// The zone for the request being handled right now (works anywhere
// downstream of timezoneMiddleware, including inside AI tool calls).
export function currentTz() {
  return als.getStore()?.tz || DEFAULT_TZ;
}

export function timezoneMiddleware(req, _res, next) {
  const run = (tz) => {
    req.userTz = tz;
    als.run({ tz }, next);
  };
  const headerTz = validTz(req.get("x-timezone"));
  let userId = null;
  const auth = req.headers.authorization || "";
  if (auth.startsWith("Bearer ")) {
    try {
      const p = verifyToken(auth.slice(7));
      if (!p.imp) userId = String(p.sub); // admin "Log in as" sessions don't overwrite the user's zone
    } catch { /* anonymous */ }
  }

  if (headerTz) {
    if (userId && pool && savedTz.get(userId) !== headerTz) {
      savedTz.set(userId, headerTz);
      pool
        .query("UPDATE users SET timezone = $1 WHERE id = $2 AND timezone IS DISTINCT FROM $1", [headerTz, userId])
        .catch((err) => { savedTz.delete(userId); console.error("save timezone:", err.message); });
    }
    return run(headerTz);
  }
  // No header (an older copy of the app): use the account's saved zone.
  if (userId && pool) {
    if (savedTz.has(userId)) return run(savedTz.get(userId) || DEFAULT_TZ);
    return pool
      .query("SELECT timezone FROM users WHERE id = $1", [userId])
      .then(({ rows }) => {
        const tz = validTz(rows[0]?.timezone);
        savedTz.set(userId, tz);
        run(tz || DEFAULT_TZ);
      })
      .catch(() => run(DEFAULT_TZ));
  }
  return run(DEFAULT_TZ);
}

// "Fri, Oct 2, 4:00 PM PDT" in the user's zone.
export function localLabel(iso, tz = currentTz()) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(d);
}

// "2026-10-02" — the calendar date in the user's zone.
export function localDay(iso, tz = currentTz()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

// Line for AI system prompts: the time now, where the user is.
export function userTimeLine(nowIso = new Date().toISOString(), tz = currentTz()) {
  return `For the user it is ${localLabel(nowIso, tz)} (time zone ${tz}). Give every game time and date in the user's time zone (e.g. "7:15 PM ${shortZone(tz)}"), never UTC or ET unless they ask.`;
}

export function shortZone(tz = currentTz(), at = new Date()) {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value || tz;
}

// Adds a "<key>_local" label next to every kickoff/start time in a tool
// result, so the AI quotes the user's local time instead of converting UTC
// itself. Returns the same object (mutated).
const TIME_KEYS = new Set(["kickoff", "commenceTime", "commence_time", "start_utc", "startTime", "gameTime"]);
export function addLocalTimes(obj, tz = currentTz(), depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return obj;
  if (Array.isArray(obj)) {
    for (const v of obj) addLocalTimes(v, tz, depth + 1);
    return obj;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (TIME_KEYS.has(k) && typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) {
      const label = localLabel(v, tz);
      if (label) obj[`${k === "start_utc" ? "start" : k}_local`] = label;
    } else if (v && typeof v === "object") {
      addLocalTimes(v, tz, depth + 1);
    }
  }
  return obj;
}
