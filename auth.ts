// auth.ts
import { db } from "./db.ts";

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PBKDF2_ITERATIONS = 100_000;

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type AuthUser = { id: number; username: string };

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(numBytes: number): string {
  const bytes = new Uint8Array(numBytes);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new TextEncoder().encode(salt),
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    256,
  );
  return toHex(new Uint8Array(bits));
}

function createSession(userId: number): string {
  const token = randomHex(32);
  const now = Date.now();
  db.prepare(
    "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
  ).run(token, userId, now, now + SESSION_TTL_MS);
  return token;
}

export async function createUser(username: string, password: string): Promise<AuthUser> {
  if (!username || !password) throw new AuthError(400, "Username and password are required.");
  if (username.length < 3) throw new AuthError(400, "Username must be at least 3 characters.");
  if (password.length < 8) throw new AuthError(400, "Password must be at least 8 characters.");
  if (db.prepare("SELECT id FROM users WHERE username = ?").get(username)) {
    throw new AuthError(409, "Username is already taken.");
  }
  const salt = randomHex(16);
  const passwordHash = await hashPassword(password, salt);
  const info = db.prepare(
    "INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)",
  ).run(username, passwordHash, salt, Date.now());
  return { id: Number(info.lastInsertRowid), username };
}

export async function loginUser(
  username: string,
  password: string,
): Promise<{ token: string; user: AuthUser }> {
  if (!username || !password) throw new AuthError(400, "Username and password are required.");
  const row = db.prepare(
    "SELECT id, username, password_hash, salt FROM users WHERE username = ?",
  ).get(username) as { id: number; username: string; password_hash: string; salt: string } | undefined;
  if (!row) throw new AuthError(401, "Invalid username or password.");
  const hash = await hashPassword(password, row.salt);
  if (!safeEqual(hash, row.password_hash)) throw new AuthError(401, "Invalid username or password.");
  return { token: createSession(row.id), user: { id: row.id, username: row.username } };
}

export function logoutSession(token: string | null): void {
  if (!token) return;
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function getUserByToken(token: string | null): AuthUser | null {
  if (!token) return null;
  const row = db.prepare(
    `SELECT s.user_id AS id, u.username AS username
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > ?`,
  ).get(token, Date.now()) as { id: number; username: string } | undefined;
  return row ? { id: row.id, username: row.username } : null;
}

export function extractToken(request: Request): string | null {
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim();
  return null;
}

export function cleanupExpiredSessions(): void {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
}
