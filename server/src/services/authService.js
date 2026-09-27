import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool, ensureSchema } from "../db.js";

// Falls back to a fixed dev secret if JWT_SECRET isn't set so local dev still
// works, but in production you should always set JWT_SECRET on Render.
const JWT_SECRET = process.env.JWT_SECRET || "betedge-dev-secret-change-me";
const TOKEN_TTL = "30d";

export function accountsAvailable() {
  return !!pool;
}

function toPublicUser(row) {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

export async function signup(email, password) {
  if (!pool) throw new Error("Accounts aren't available yet — no database configured.");
  if (!email || !password) throw new Error("Email and password are required.");
  if (password.length < 8) throw new Error("Password must be at least 8 characters.");

  await ensureSchema();
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [normalizedEmail]);
  if (existing.rows.length) throw new Error("An account with that email already exists.");

  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at",
    [normalizedEmail, passwordHash]
  );
  const user = toPublicUser(rows[0]);
  return { user, token: signToken(user) };
}

export async function login(email, password) {
  if (!pool) throw new Error("Accounts aren't available yet — no database configured.");
  if (!email || !password) throw new Error("Email and password are required.");

  await ensureSchema();
  const normalizedEmail = (email || "").trim().toLowerCase();
  const { rows } = await pool.query("SELECT * FROM users WHERE email = $1", [normalizedEmail]);
  if (!rows.length) throw new Error("Invalid email or password.");

  const row = rows[0];
  const ok = await bcrypt.compare(password, row.password_hash);
  if (!ok) throw new Error("Invalid email or password.");

  const user = toPublicUser(row);
  return { user, token: signToken(user) };
}
