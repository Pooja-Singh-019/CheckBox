import crypto from "node:crypto";
import { resolve4, resolve6, resolveMx } from "node:dns/promises";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";


import express from "express";
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { createClient } from "redis";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 3000);
const CHECKBOX_COUNT = Number(process.env.CHECKBOX_COUNT || 507);
const ROUND_RESET_DELAY_MS = Number(process.env.ROUND_RESET_DELAY_MS || 9000);
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const ISSUER = process.env.OIDC_ISSUER || `http://localhost:${PORT}`;
const ACCESS_TOKEN_TTL_SEC = Number(process.env.ACCESS_TOKEN_TTL_SEC || 3600);
const hasExternalDatabaseUrl = Boolean(
  String(process.env.DATABASE_URL || process.env.POSTGRES_URL || "").trim()
);
const DB_CLIENT = String(
  process.env.DB_CLIENT || (hasExternalDatabaseUrl ? "postgres" : "sqlite")
).toLowerCase();
const OTP_TTL_SEC = Number(process.env.OTP_TTL_SEC || 600);
const OTP_VERIFIED_TTL_SEC = Number(process.env.OTP_VERIFIED_TTL_SEC || 1800);
const OTP_MAX_ATTEMPTS = Number(process.env.OTP_MAX_ATTEMPTS || 5);
const OTP_RESEND_COOLDOWN_SEC = Number(process.env.OTP_RESEND_COOLDOWN_SEC || 45);
const OTP_PROVIDER = String(process.env.OTP_PROVIDER || "console").toLowerCase();
const OTP_FROM_EMAIL = String(process.env.OTP_FROM_EMAIL || "no-reply@example.com");
const OTP_EMAIL_SUBJECT = String(process.env.OTP_EMAIL_SUBJECT || "Your OneMillionBox verification code");
const RESEND_API_KEY = String(process.env.RESEND_API_KEY || "").trim();
const OTP_HMAC_SECRET = String(process.env.OTP_HMAC_SECRET || crypto.randomBytes(32).toString("hex"));
const ADMIN_EMAILS = String(process.env.ADMIN_EMAILS || "")
  .split(",")
  .map((email) => normalizeEmail(email))
  .filter(Boolean);
const ADMIN_API_KEY = String(process.env.ADMIN_API_KEY || "").trim();
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, "").toLowerCase())
  .filter(Boolean);
const ISSUER_ORIGIN = (() => {
  try {
    return new URL(ISSUER).origin.toLowerCase();
  } catch {
    return "";
  }
})();

const HUNTER_KEY = "onebox:hunter:v1";
const CHECKED_BITS_KEY = "onebox:checked:bits:v1";
const PUBSUB_CHANNEL = "onebox:checkbox:events:v1";
const DB_FILE_NAME = "one-million-box.sqlite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");
const frontendRoot = path.resolve(projectRoot, "..", "frontend");
const dataDir = path.join(projectRoot, "data");
const dbPath = path.join(dataDir, DB_FILE_NAME);

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "150kb" }));

const redisOptions = {
  url: REDIS_URL,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: () => false,
  },
};

const redis = createClient(redisOptions);
const redisPub = createClient(redisOptions);
const redisSub = createClient(redisOptions);

const sockets = new Map();
let privateKey;
let publicKey;
let jwk;
let db;
let dbProvider = "sqlite";
let roundResetTimer = null;
let redisEnabled = false;
const memoryUsersByEmail = new Map();
const emailDomainValidityCache = new Map();
const memoryEmailVerifications = new Map();

let memoryHunterPosition = Math.floor(Math.random() * CHECKBOX_COUNT) + 1;
const memoryCheckedBits = new Uint8Array(CHECKBOX_COUNT);
const memoryRateBuckets = new Map();

function json(res, status, payload) {
  res.status(status).json(payload);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function nowMs() {
  return Date.now();
}

function normalizeOrigin(origin) {
  return String(origin || "").trim().replace(/\/+$/, "").toLowerCase();
}

function getRequestOriginHint(headers) {
  const rawHost = String(
    headers?.["x-forwarded-host"] || headers?.host || ""
  )
    .split(",")[0]
    .trim();

  if (!rawHost) {
    return "";
  }

  const forwardedProto = String(headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim()
    .toLowerCase();

  const protocol =
    forwardedProto === "https" || forwardedProto === "wss" ? "https" : "http";

  return `${protocol}://${rawHost}`;
}

function isOriginAllowed(origin, requestOriginHint = "") {
  if (!origin) {
    return true;
  }

  const normalizedOrigin = normalizeOrigin(origin);
  if (requestOriginHint && normalizedOrigin === normalizeOrigin(requestOriginHint)) {
    return true;
  }

  if (ISSUER_ORIGIN && normalizedOrigin === ISSUER_ORIGIN) {
    return true;
  }

  if (ALLOWED_ORIGINS.length === 0) {
    return true;
  }

  return ALLOWED_ORIGINS.includes(normalizedOrigin);
}

async function hasDeliverableEmailDomain(email) {
  const atIndex = email.lastIndexOf("@");
  if (atIndex < 1 || atIndex === email.length - 1) {
    return false;
  }

  const domain = email.slice(atIndex + 1).toLowerCase();
  if (emailDomainValidityCache.has(domain)) {
    return emailDomainValidityCache.get(domain);
  }

  let valid = false;

  try {
    const mxRecords = await resolveMx(domain);
    valid = Array.isArray(mxRecords) && mxRecords.length > 0;
  } catch {
    // Continue to fallback checks below.
  }

  if (!valid) {
    try {
      const aRecords = await resolve4(domain);
      valid = Array.isArray(aRecords) && aRecords.length > 0;
    } catch {
      // Continue to AAAA fallback.
    }
  }

  if (!valid) {
    try {
      const aaaaRecords = await resolve6(domain);
      valid = Array.isArray(aaaaRecords) && aaaaRecords.length > 0;
    } catch {
      valid = false;
    }
  }

  emailDomainValidityCache.set(domain, valid);
  return valid;
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function hashOtpCode(email, otpCode) {
  return crypto
    .createHmac("sha256", OTP_HMAC_SECRET)
    .update(`${normalizeEmail(email)}:${otpCode}`)
    .digest("hex");
}

function sanitizeOtpVerification(record) {
  if (!record) {
    return null;
  }

  return {
    email: normalizeEmail(record.email),
    otpHash: String(record.otpHash || ""),
    expiresAt: Number(record.expiresAt || 0),
    resendAvailableAt: Number(record.resendAvailableAt || 0),
    attemptCount: Number(record.attemptCount || 0),
    verifiedAt: record.verifiedAt ? Number(record.verifiedAt) : null,
    createdAt: Number(record.createdAt || 0),
    updatedAt: Number(record.updatedAt || 0),
  };
}

async function getEmailVerification(email) {
  const normalizedEmail = normalizeEmail(email);

  if (dbProvider === "memory") {
    return sanitizeOtpVerification(memoryEmailVerifications.get(normalizedEmail) || null);
  }

  if (dbProvider === "postgres") {
    const result = await db.query(
      `
        SELECT
          email,
          otp_hash AS "otpHash",
          expires_at AS "expiresAt",
          resend_available_at AS "resendAvailableAt",
          attempt_count AS "attemptCount",
          verified_at AS "verifiedAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM email_verifications
        WHERE email = $1
        LIMIT 1
      `,
      [normalizedEmail]
    );

    return sanitizeOtpVerification(result.rows[0] || null);
  }

  const row = await db.get(
    `
      SELECT
        email,
        otp_hash AS otpHash,
        expires_at AS expiresAt,
        resend_available_at AS resendAvailableAt,
        attempt_count AS attemptCount,
        verified_at AS verifiedAt,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM email_verifications
      WHERE email = ?
      LIMIT 1
    `,
    normalizedEmail
  );

  return sanitizeOtpVerification(row || null);
}

async function saveEmailVerification({
  email,
  otpHash,
  expiresAt,
  resendAvailableAt,
  attemptCount,
  verifiedAt,
}) {
  const normalizedEmail = normalizeEmail(email);
  const createdAt = nowMs();
  const updatedAt = createdAt;
  const payload = {
    email: normalizedEmail,
    otpHash: String(otpHash || ""),
    expiresAt: Number(expiresAt || 0),
    resendAvailableAt: Number(resendAvailableAt || 0),
    attemptCount: Number(attemptCount || 0),
    verifiedAt: verifiedAt ? Number(verifiedAt) : null,
    createdAt,
    updatedAt,
  };

  if (dbProvider === "memory") {
    const previous = memoryEmailVerifications.get(normalizedEmail);
    if (previous?.createdAt) {
      payload.createdAt = previous.createdAt;
    }

    memoryEmailVerifications.set(normalizedEmail, payload);
    return;
  }

  if (dbProvider === "postgres") {
    await db.query(
      `
        INSERT INTO email_verifications (
          email, otp_hash, expires_at, resend_available_at, attempt_count, verified_at, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (email) DO UPDATE SET
          otp_hash = EXCLUDED.otp_hash,
          expires_at = EXCLUDED.expires_at,
          resend_available_at = EXCLUDED.resend_available_at,
          attempt_count = EXCLUDED.attempt_count,
          verified_at = EXCLUDED.verified_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        payload.email,
        payload.otpHash,
        payload.expiresAt,
        payload.resendAvailableAt,
        payload.attemptCount,
        payload.verifiedAt,
        payload.createdAt,
        payload.updatedAt,
      ]
    );
    return;
  }

  await db.run(
    `
      INSERT INTO email_verifications (
        email, otp_hash, expires_at, resend_available_at, attempt_count, verified_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        otp_hash = excluded.otp_hash,
        expires_at = excluded.expires_at,
        resend_available_at = excluded.resend_available_at,
        attempt_count = excluded.attempt_count,
        verified_at = excluded.verified_at,
        updated_at = excluded.updated_at
    `,
    payload.email,
    payload.otpHash,
    payload.expiresAt,
    payload.resendAvailableAt,
    payload.attemptCount,
    payload.verifiedAt,
    payload.createdAt,
    payload.updatedAt
  );
}

async function clearEmailVerification(email) {
  const normalizedEmail = normalizeEmail(email);

  if (dbProvider === "memory") {
    memoryEmailVerifications.delete(normalizedEmail);
    return;
  }

  if (dbProvider === "postgres") {
    await db.query(`DELETE FROM email_verifications WHERE email = $1`, [normalizedEmail]);
    return;
  }

  await db.run(`DELETE FROM email_verifications WHERE email = ?`, normalizedEmail);
}

async function markEmailVerified(email) {
  const record = await getEmailVerification(email);
  if (!record) {
    return;
  }

  await saveEmailVerification({
    email: record.email,
    otpHash: "",
    expiresAt: 0,
    resendAvailableAt: 0,
    attemptCount: 0,
    verifiedAt: nowMs(),
  });
}

function isEmailRecentlyVerified(record) {
  if (!record || !record.verifiedAt) {
    return false;
  }

  const ageMs = nowMs() - Number(record.verifiedAt);
  return ageMs >= 0 && ageMs <= OTP_VERIFIED_TTL_SEC * 1000;
}

async function sendOtpEmail(email, otpCode) {
  const targetEmail = normalizeEmail(email);

  if (OTP_PROVIDER === "console") {
    console.log(`[otp] email=${targetEmail} code=${otpCode}`);
    return { provider: "console" };
  }

  if (OTP_PROVIDER === "resend") {
    if (!RESEND_API_KEY) {
      throw new Error("RESEND_API_KEY is missing.");
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: OTP_FROM_EMAIL,
        to: [targetEmail],
        subject: OTP_EMAIL_SUBJECT,
        html: `<p>Your OneMillionBox OTP is <strong>${otpCode}</strong>. It expires in ${Math.ceil(
          OTP_TTL_SEC / 60
        )} minutes.</p>`,
        text: `Your OneMillionBox OTP is ${otpCode}. It expires in ${Math.ceil(OTP_TTL_SEC / 60)} minutes.`,
      }),
    });

    if (!response.ok) {
      const bodyText = await response.text();
      throw new Error(`resend_send_failed: ${response.status} ${bodyText.slice(0, 200)}`);
    }

    return { provider: "resend" };
  }

  throw new Error(`Unsupported OTP_PROVIDER: ${OTP_PROVIDER}`);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function createPasswordRecord(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const digest = hashPassword(password, salt);
  return `${salt}:${digest}`;
}

function verifyPassword(password, stored) {
  const [salt, digest] = String(stored || "").split(":");
  if (!salt || !digest) {
    return false;
  }

  const candidate = hashPassword(password, salt);
  const left = Buffer.from(digest, "hex");
  const right = Buffer.from(candidate, "hex");

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

function parseAuthHeader(headerValue) {
  const value = String(headerValue || "");
  if (!value.startsWith("Bearer ")) {
    return null;
  }

  return value.slice(7).trim();
}

function parseTogglePayload(raw) {
  if (!raw || raw.type !== "checkbox:toggle" || typeof raw.data !== "object") {
    return null;
  }

  const position = Number(raw.data.position);
  const checked = Boolean(raw.data.checked);

  if (!Number.isInteger(position) || position < 1 || position > CHECKBOX_COUNT) {
    return null;
  }

  return { position, checked };
}

async function issueAccessToken(user) {
  return new SignJWT({
    scope: "checkbox:read checkbox:write",
    email: user.email,
    name: user.name,
  })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(ISSUER)
    .setAudience("onebox-client")
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SEC}s`)
    .sign(privateKey);
}

async function verifyAccessToken(token) {
  try {
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: ISSUER,
      audience: "onebox-client",
    });

    return payload;
  } catch {
    return null;
  }
}

async function initDatabase() {
  if (DB_CLIENT === "postgres" || DB_CLIENT === "postgresql" || DB_CLIENT === "pg") {
    try {
      const { Pool } = await import("pg");
      db = new Pool({
        connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined,
      });

      await db.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          created_at BIGINT NOT NULL
        );
      `);

      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_users_created_at
        ON users(created_at DESC);
      `);

      await db.query(`
        CREATE TABLE IF NOT EXISTS email_verifications (
          email TEXT PRIMARY KEY,
          otp_hash TEXT NOT NULL,
          expires_at BIGINT NOT NULL,
          resend_available_at BIGINT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          verified_at BIGINT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
      `);

      dbProvider = "postgres";
      return;
    } catch (error) {
      console.warn("Postgres unavailable. Falling back to in-memory users.");
      console.warn(error.message);
      dbProvider = "memory";
      return;
    }
  }

  try {
    await fs.mkdir(dataDir, { recursive: true });

    const sqlite3 = (await import("sqlite3")).default;
    const { open: openSqlite } = await import("sqlite");

    db = await openSqlite({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_created_at
      ON users(created_at DESC);

      CREATE TABLE IF NOT EXISTS email_verifications (
        email TEXT PRIMARY KEY,
        otp_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        resend_available_at INTEGER NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        verified_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    dbProvider = "sqlite";
  } catch (error) {
    console.warn("SQLite unavailable. Falling back to in-memory users.");
    console.warn(error.message);
    dbProvider = "memory";
  }
}

async function findUserByEmail(email) {
  if (dbProvider === "memory") {
    return memoryUsersByEmail.get(email) || null;
  }

  if (dbProvider === "postgres") {
    const result = await db.query(
      `
        SELECT id, name, email, password_hash AS "passwordHash", created_at AS "createdAt"
        FROM users
        WHERE email = $1
        LIMIT 1
      `,
      [email]
    );

    return result.rows[0] || null;
  }

  return db.get(
    `
      SELECT id, name, email, password_hash AS passwordHash, created_at AS createdAt
      FROM users
      WHERE email = ?
      LIMIT 1
    `,
    email
  );
}

async function createUser({ name, email, password }) {
  const user = {
    id: crypto.randomUUID(),
    name,
    email,
    passwordHash: createPasswordRecord(password),
    createdAt: Date.now(),
  };

  if (dbProvider === "memory") {
    memoryUsersByEmail.set(user.email, user);
  } else if (dbProvider === "postgres") {
    await db.query(
      `
        INSERT INTO users (id, name, email, password_hash, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [user.id, user.name, user.email, user.passwordHash, user.createdAt]
    );
  } else {
    await db.run(
      `
        INSERT INTO users (id, name, email, password_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      user.id,
      user.name,
      user.email,
      user.passwordHash,
      user.createdAt
    );
  }

  return user;
}

async function listUsers({ limit = 100, offset = 0 } = {}) {
  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const safeOffset = Math.max(0, Number(offset) || 0);

  if (dbProvider === "memory") {
    const users = [...memoryUsersByEmail.values()]
      .sort((left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0))
      .slice(safeOffset, safeOffset + safeLimit)
      .map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
      }));

    return users;
  }

  if (dbProvider === "postgres") {
    const result = await db.query(
      `
        SELECT id, name, email, created_at AS "createdAt"
        FROM users
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `,
      [safeLimit, safeOffset]
    );

    return result.rows;
  }

  const rows = await db.all(
    `
      SELECT id, name, email, created_at AS createdAt
      FROM users
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `,
    safeLimit,
    safeOffset
  );

  return rows;
}

function isAdminEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) {
    return false;
  }

  return ADMIN_EMAILS.includes(normalized);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatAdminDate(timestamp) {
  const date = new Date(Number(timestamp || 0));
  if (Number.isNaN(date.getTime())) {
    return "Unknown";
  }

  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  });
}

function renderAdminUsersPage({ users, hunterPosition, database, actor }) {
  const userRows = users.length
    ? users
        .map(
          (user, index) => `
            <article class="user-row">
              <div class="user-index">${index + 1}</div>
              <div class="user-details">
                <strong>${escapeHtml(user.name)}</strong>
                <span>${escapeHtml(user.email)}</span>
                <small>ID: ${escapeHtml(user.id)}</small>
                <small>Created: ${escapeHtml(formatAdminDate(user.createdAt))}</small>
              </div>
            </article>
          `
        )
        .join("")
    : `<p class="empty">No users found.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OneMillionBox Admin</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      padding: 28px;
      background: #f4f7fb;
      color: #182033;
      font-family: "Segoe UI", Arial, sans-serif;
    }
    main {
      max-width: 860px;
      margin: 0 auto;
    }
    header {
      display: grid;
      gap: 12px;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 2rem;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    .stat,
    .user-row {
      border: 1px solid #d8e0ef;
      border-radius: 12px;
      background: #ffffff;
      box-shadow: 0 10px 24px rgba(28, 41, 74, 0.08);
    }
    .stat {
      padding: 14px 16px;
    }
    .stat span {
      display: block;
      color: #66708a;
      font-size: 0.84rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .stat strong {
      display: block;
      margin-top: 4px;
      font-size: 1.45rem;
    }
    .users {
      display: grid;
      gap: 10px;
    }
    .user-row {
      display: grid;
      grid-template-columns: 44px 1fr;
      gap: 12px;
      padding: 14px;
    }
    .user-index {
      display: grid;
      place-items: center;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #e7f3ff;
      color: #155e9f;
      font-weight: 800;
    }
    .user-details {
      display: grid;
      gap: 4px;
    }
    .user-details span {
      color: #34405c;
    }
    .user-details small {
      color: #6d7892;
      overflow-wrap: anywhere;
    }
    .empty {
      padding: 18px;
      border-radius: 12px;
      background: #ffffff;
      border: 1px solid #d8e0ef;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Admin Users</h1>
    </header>
    <section class="stats">
      <div class="stat"><span>Total Shown</span><strong>${users.length}</strong></div>
      <div class="stat"><span>Fox Position</span><strong>${escapeHtml(hunterPosition)}</strong></div>
      <div class="stat"><span>Database</span><strong>${escapeHtml(database)}</strong></div>
      <div class="stat"><span>Actor</span><strong>${escapeHtml(actor)}</strong></div>
    </section>
    <section class="users">${userRows}</section>
  </main>
</body>
</html>`;
}

function getDatabaseLogInfo() {
  if (dbProvider === "postgres") {
    return "postgres";
  }

  if (dbProvider === "memory") {
    return "memory (ephemeral)";
  }

  return `sqlite (${dbPath})`;
}

function broadcast(message) {
  const payload = JSON.stringify(message);

  for (const socketMeta of sockets.values()) {
    if (socketMeta.socket.readyState === socketMeta.socket.OPEN) {
      socketMeta.socket.send(payload);
    }
  }
}

function broadcastPresence() {
  let authenticatedSockets = 0;
  const authenticatedUserIds = new Set();

  for (const socketMeta of sockets.values()) {
    if (!socketMeta.readOnly) {
      authenticatedSockets += 1;
      if (socketMeta.userId) {
        authenticatedUserIds.add(String(socketMeta.userId));
      }
    }
  }

  broadcast({
    type: "presence",
    data: {
      connectedSockets: sockets.size,
      authenticatedSockets,
      authenticatedUsers: authenticatedUserIds.size,
    },
  });
}

function publishEvent(message) {
  if (redisEnabled) {
    return redisPub.publish(PUBSUB_CHANNEL, JSON.stringify(message));
  }

  broadcast(message);
  return Promise.resolve();
}

async function ensureGameState() {
  if (!redisEnabled) {
    return memoryHunterPosition;
  }

  const current = Number(await redis.get(HUNTER_KEY));
  if (Number.isInteger(current) && current >= 1 && current <= CHECKBOX_COUNT) {
    return current;
  }

  const hunterPosition = Math.floor(Math.random() * CHECKBOX_COUNT) + 1;
  await redis.set(HUNTER_KEY, String(hunterPosition));
  await redis.del(CHECKED_BITS_KEY);
  return hunterPosition;
}

async function listCheckedPositions() {
  if (!redisEnabled) {
    const checkedPositions = [];
    for (let index = 0; index < CHECKBOX_COUNT; index++) {
      if (memoryCheckedBits[index] === 1) {
        checkedPositions.push(index + 1);
      }
    }
    return checkedPositions;
  }

  const pipeline = redis.multi();
  for (let index = 0; index < CHECKBOX_COUNT; index++) {
    pipeline.getBit(CHECKED_BITS_KEY, index);
  }

  const bitValues = await pipeline.exec();
  const checkedPositions = [];

  bitValues.forEach((value, index) => {
    if (Number(value) === 1) {
      checkedPositions.push(index + 1);
    }
  });

  return checkedPositions;
}

async function getSnapshot() {
  const hunterPosition = await ensureGameState();
  const checkedPositions = await listCheckedPositions();

  return {
    count: CHECKBOX_COUNT,
    hunterPosition,
    checkedPositions,
    updatedAt: Date.now(),
  };
}

async function checkRateLimit({ subject, limit, windowSec, prefix }) {
  const bucket = Math.floor(Date.now() / (windowSec * 1000));
  const key = `${prefix}:${subject}:${bucket}`;

  if (!redisEnabled) {
    const now = Date.now();
    const existing = memoryRateBuckets.get(key);

    if (!existing || existing.expiresAt < now) {
      memoryRateBuckets.set(key, {
        count: 1,
        expiresAt: now + windowSec * 1000,
      });
      return { allowed: true, count: 1 };
    }

    existing.count += 1;
    return {
      allowed: existing.count <= limit,
      count: existing.count,
    };
  }

  const result = await redis
    .multi()
    .incr(key)
    .expire(key, windowSec, { NX: true })
    .exec();

  const count = Number(result?.[0] || 0);

  return {
    allowed: count <= limit,
    count,
  };
}

function createRestRateLimiter({ prefix, limit, windowSec, identityResolver }) {
  return async (req, res, next) => {
    try {
      const identity = identityResolver(req);
      const rate = await checkRateLimit({
        subject: identity,
        limit,
        windowSec,
        prefix,
      });

      if (!rate.allowed) {
        json(res, 429, {
          error: "rate_limited",
          message: "Too many requests. Please slow down.",
        });
        return;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

async function setCheckedBit(position, checked) {
  if (!redisEnabled) {
    memoryCheckedBits[position - 1] = checked ? 1 : 0;
    return;
  }

  await redis.setBit(CHECKED_BITS_KEY, position - 1, checked ? 1 : 0);
}

async function getHunterPosition() {
  if (!redisEnabled) {
    return memoryHunterPosition;
  }

  return Number(await redis.get(HUNTER_KEY));
}

async function resetRound(reason) {
  const hunterPosition = Math.floor(Math.random() * CHECKBOX_COUNT) + 1;

  if (!redisEnabled) {
    memoryHunterPosition = hunterPosition;
    memoryCheckedBits.fill(0);
  } else {
    await redis
      .multi()
      .set(HUNTER_KEY, String(hunterPosition))
      .del(CHECKED_BITS_KEY)
      .exec();
  }

  await publishEvent({
    type: "round:reset",
    data: {
      reason,
      hunterPosition,
      checkedPositions: [],
      updatedAt: Date.now(),
    },
  });
}

function scheduleRoundReset() {
  if (roundResetTimer) {
    return;
  }

  roundResetTimer = setTimeout(async () => {
    roundResetTimer = null;
    await resetRound("hunter_found");
  }, ROUND_RESET_DELAY_MS);
}

async function bootstrapKeys() {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;

  jwk = await exportJWK(publicKey);
  jwk.use = "sig";
  jwk.alg = "RS256";
  jwk.kid = "onebox-main-key";
}

async function bootstrapRedis() {
  redis.on("error", (error) => {
    console.error("[redis]", error.message);
  });
  redisPub.on("error", (error) => {
    console.error("[redis-pub]", error.message);
  });
  redisSub.on("error", (error) => {
    console.error("[redis-sub]", error.message);
  });

  try {
    await Promise.all([redis.connect(), redisPub.connect(), redisSub.connect()]);
    redisEnabled = true;
    await ensureGameState();

    await redisSub.subscribe(PUBSUB_CHANNEL, (rawMessage) => {
      try {
        const message = JSON.parse(rawMessage);
        broadcast(message);

        if (message.type === "round:reset") {
          roundResetTimer = null;
        }
      } catch {
        // Ignore malformed messages.
      }
    });
  } catch (error) {
    redisEnabled = false;
    console.warn("Redis unavailable. Running in single-instance memory fallback mode.");
    console.warn(error.message);

    await Promise.allSettled([
      redis.quit(),
      redisPub.quit(),
      redisSub.quit(),
    ]);
  }
}

const authLimiter = createRestRateLimiter({
  prefix: "ratelimit:auth",
  limit: 20,
  windowSec: 60,
  identityResolver: (req) => req.ip || "unknown-ip",
});

const generalLimiter = createRestRateLimiter({
  prefix: "ratelimit:rest",
  limit: 120,
  windowSec: 60,
  identityResolver: (req) => req.ip || "unknown-ip",
});

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const requestOriginHint = getRequestOriginHint(req.headers);
  const allowOrigin = origin && isOriginAllowed(origin, requestOriginHint);

  if (allowOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }

  if (req.method === "OPTIONS") {
    if (origin && !allowOrigin) {
      res.status(403).end();
      return;
    }

    res.status(204).end();
    return;
  }

  next();
});

app.use(generalLimiter);

app.get("/health", (req, res) => {
  json(res, 200, {
    ok: true,
    connectedSockets: sockets.size,
    redisEnabled,
    database: dbProvider,
    dbClientRequested: DB_CLIENT,
    adminConfigured: ADMIN_EMAILS.length > 0 || Boolean(ADMIN_API_KEY),
  });
});

app.get("/.well-known/openid-configuration", (req, res) => {
  json(res, 200, {
    issuer: ISSUER,
    jwks_uri: `${ISSUER}/.well-known/jwks.json`,
    token_endpoint: `${ISSUER}/auth/token`,
    userinfo_endpoint: `${ISSUER}/auth/userinfo`,
    registration_endpoint: `${ISSUER}/auth/register`,
    grant_types_supported: ["password"],
    token_endpoint_auth_methods_supported: ["none"],
    response_types_supported: ["token"],
    scopes_supported: ["checkbox:read", "checkbox:write"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  });
});

app.get("/.well-known/jwks.json", (req, res) => {
  json(res, 200, { keys: [jwk] });
});

app.post("/auth/register", authLimiter, async (req, res, next) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (name.length < 2) {
      json(res, 400, { error: "invalid_name", message: "Name is too short." });
      return;
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      json(res, 400, { error: "invalid_email", message: "Email format is invalid." });
      return;
    }

    const hasValidDomain = await hasDeliverableEmailDomain(email);
    if (!hasValidDomain) {
      json(res, 400, {
        error: "invalid_email_domain",
        message: "Email domain does not appear to receive mail.",
      });
      return;
    }

    const hasLetter = /[A-Za-z]/.test(password);
    const hasDigit = /\d/.test(password);
    const hasSymbol = /[^A-Za-z0-9\s]/.test(password);

    if (password.length < 8 || !hasLetter || (!hasDigit && !hasSymbol)) {
      json(res, 400, {
        error: "weak_password",
        message: "Password must be 8+ chars and include letters plus a number or symbol (like @).",
      });
      return;
    }

    const existing = await findUserByEmail(email);
    if (existing) {
      json(res, 409, {
        error: "already_registered",
        message: "This email is already registered.",
      });
      return;
    }

    const user = await createUser({ name, email, password });

    json(res, 201, {
      ok: true,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        createdAt: user.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.post("/auth/token", authLimiter, async (req, res, next) => {
  try {
    const grantType = String(req.body?.grant_type || "password");
    const email = normalizeEmail(req.body?.username || req.body?.email);
    const password = String(req.body?.password || "");

    if (grantType !== "password") {
      json(res, 400, {
        error: "unsupported_grant_type",
        message: "Only password grant is supported in this project.",
      });
      return;
    }

    const user = await findUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      json(res, 401, {
        error: "invalid_credentials",
        message: "Invalid credentials.",
      });
      return;
    }

    const accessToken = await issueAccessToken(user);

    json(res, 200, {
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SEC,
      access_token: accessToken,
      scope: "checkbox:read checkbox:write",
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get("/auth/userinfo", async (req, res, next) => {
  try {
    const token = parseAuthHeader(req.headers.authorization);
    if (!token) {
      json(res, 401, {
        error: "missing_token",
        message: "Bearer token is required.",
      });
      return;
    }

    const payload = await verifyAccessToken(token);
    if (!payload) {
      json(res, 401, {
        error: "invalid_token",
        message: "Token is invalid or expired.",
      });
      return;
    }

    json(res, 200, {
      sub: payload.sub,
      name: payload.name,
      email: payload.email,
      scope: payload.scope,
    });
  } catch (error) {
    next(error);
  }
});

app.get(["/admin", "/admin/users"], async (req, res, next) => {
  try {
    const queryLimit = Number(req.query?.limit || 100);
    const queryOffset = Number(req.query?.offset || 0);
    const providedAdminKey = String(
      req.headers["x-admin-key"] || req.query?.admin_key || ""
    ).trim();

    let authorized = false;
    let actor = "unknown";

    if (ADMIN_API_KEY && providedAdminKey && providedAdminKey === ADMIN_API_KEY) {
      authorized = true;
      actor = "admin_key";
    } else {
      const token = parseAuthHeader(req.headers.authorization);
      if (token) {
        const payload = await verifyAccessToken(token);
        if (payload && isAdminEmail(payload.email)) {
          authorized = true;
          actor = normalizeEmail(payload.email);
        }
      }
    }

    if (!authorized) {
      json(res, 403, {
        error: "admin_forbidden",
        message: "Admin access required.",
      });
      return;
    }

    const users = await listUsers({
      limit: queryLimit,
      offset: queryOffset,
    });
    const snapshot = await getSnapshot();
    const wantsHtml =
      String(req.query?.format || "").toLowerCase() === "html" ||
      String(req.headers.accept || "").includes("text/html");

    if (wantsHtml) {
      res
        .status(200)
        .type("html")
        .send(
          renderAdminUsersPage({
            users,
            hunterPosition: snapshot.hunterPosition,
            database: dbProvider,
            actor,
          })
        );
      return;
    }

    json(res, 200, {
      ok: true,
      actor,
      database: dbProvider,
      foxPosition: snapshot.hunterPosition,
      hunterPosition: snapshot.hunterPosition,
      count: users.length,
      users,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/game/snapshot", async (req, res, next) => {
  try {
    const token = parseAuthHeader(req.headers.authorization);
    const payload = token ? await verifyAccessToken(token) : null;
    const snapshot = await getSnapshot();

    json(res, 200, {
      ...snapshot,
      readOnly: !payload,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/game/toggle", async (req, res, next) => {
  try {
    const token = parseAuthHeader(req.headers.authorization);
    if (!token) {
      json(res, 401, {
        error: "missing_token",
        message: "Bearer token is required.",
      });
      return;
    }

    const payload = await verifyAccessToken(token);
    if (!payload) {
      json(res, 401, {
        error: "invalid_token",
        message: "Token is invalid or expired.",
      });
      return;
    }

    const toggle = parseTogglePayload({
      type: "checkbox:toggle",
      data: req.body || {},
    });

    if (!toggle) {
      json(res, 400, {
        error: "invalid_toggle",
        message: "Checkbox toggle payload is invalid.",
      });
      return;
    }

    const rate = await checkRateLimit({
      subject: `${payload.sub || "user"}:${req.ip || "unknown-ip"}`,
      limit: 40,
      windowSec: 10,
      prefix: "ratelimit:toggle:rest",
    });

    if (!rate.allowed) {
      json(res, 429, {
        error: "rate_limited",
        message: "Too many toggles in a short time.",
      });
      return;
    }

    await setCheckedBit(toggle.position, toggle.checked);
    const hunterPosition = await getHunterPosition();

    await publishEvent({
      type: "checkbox:update",
      data: {
        position: toggle.position,
        checked: toggle.checked,
        updatedBy: payload.sub || null,
        updatedAt: Date.now(),
      },
    });

    const won = toggle.checked && toggle.position === hunterPosition;
    const winnerName = payload.name || "Guardian";
    if (won) {
      await publishEvent({
        type: "round:won",
        data: {
          winnerUserId: payload.sub || null,
          winnerName,
          hunterPosition,
          updatedAt: Date.now(),
        },
      });

      scheduleRoundReset();
    }

    json(res, 200, {
      ok: true,
      position: toggle.position,
      checked: toggle.checked,
      won,
      winnerName: won ? winnerName : null,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/", (req, res) => {
  res.sendFile(path.join(frontendRoot, "index.html"));
});

app.use(express.static(frontendRoot, { extensions: ["html"] }));
app.use("/frontend", express.static(frontendRoot, { extensions: ["html"] }));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  try {
    const upgradeUrl = new URL(request.url || "", `http://${request.headers.host}`);
    const requestOrigin = request.headers.origin;
    const requestOriginHint = getRequestOriginHint(request.headers);

    if (!isOriginAllowed(requestOrigin, requestOriginHint)) {
      console.warn(
        `[ws-origin-blocked] origin=${String(requestOrigin || "")} expected=${requestOriginHint}`
      );
      socket.destroy();
      return;
    }

    if (upgradeUrl.pathname !== "/ws") {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request, upgradeUrl);
    });
  } catch {
    socket.destroy();
  }
});

wss.on("connection", async (socket, request, upgradeUrl) => {
  const socketId = crypto.randomUUID();
  const token = upgradeUrl.searchParams.get("token");

  let userPayload = null;
  if (token) {
    userPayload = await verifyAccessToken(token);
  }

  const socketMeta = {
    socket,
    socketId,
    readOnly: !userPayload,
    userId: userPayload?.sub || null,
    userName: userPayload?.name || "Guest",
  };

  sockets.set(socketId, socketMeta);

  const snapshot = await getSnapshot();
  socket.send(
    JSON.stringify({
      type: "snapshot",
      data: {
        ...snapshot,
        socketId,
        readOnly: socketMeta.readOnly,
      },
    })
  );

  broadcastPresence();

  socket.on("message", async (rawPayload) => {
    try {
      const parsed = JSON.parse(String(rawPayload));
      const toggle = parseTogglePayload(parsed);

      if (!toggle) {
        return;
      }

      if (socketMeta.readOnly) {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "read_only",
            message: "Login is required to toggle checkboxes.",
          })
        );
        return;
      }

      const rate = await checkRateLimit({
        subject: `${socketMeta.userId}:${socketMeta.socketId}`,
        limit: 40,
        windowSec: 10,
        prefix: "ratelimit:toggle",
      });

      if (!rate.allowed) {
        socket.send(
          JSON.stringify({
            type: "error",
            code: "rate_limited",
            message: "Too many toggles in a short time.",
          })
        );
        return;
      }

      await setCheckedBit(toggle.position, toggle.checked);
      const hunterPosition = await getHunterPosition();

      await publishEvent({
        type: "checkbox:update",
        data: {
          position: toggle.position,
          checked: toggle.checked,
          updatedBy: socketMeta.userId,
          updatedAt: Date.now(),
        },
      });

      if (toggle.checked && toggle.position === hunterPosition) {
        await publishEvent({
          type: "round:won",
          data: {
            winnerUserId: socketMeta.userId,
            winnerName: socketMeta.userName,
            hunterPosition,
            updatedAt: Date.now(),
          },
        });

        scheduleRoundReset();
      }
    } catch {
      socket.send(
        JSON.stringify({
          type: "error",
          code: "bad_payload",
          message: "Incoming message is invalid JSON.",
        })
      );
    }
  });

  socket.on("close", () => {
    sockets.delete(socketId);
    broadcastPresence();
  });
});

app.use((error, req, res, next) => {
  console.error("[server-error]", error);
  json(res, 500, {
    error: "internal_error",
    message: "Something went wrong.",
  });
});

try {
  await bootstrapKeys();
  await initDatabase();
  await bootstrapRedis();
} catch (error) {
  console.error("Startup failed. Ensure dependencies are available.");
  console.error(`Database config: client=${DB_CLIENT}`);
  console.error(error.message);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(`OneMillionBox server running on ${ISSUER}`);
  console.log(`WebSocket endpoint: ${ISSUER.replace("http", "ws")}/ws`);
  console.log(`Redis enabled: ${redisEnabled}`);
  console.log(`Database: ${getDatabaseLogInfo()}`);
  console.log(`OTP provider: ${OTP_PROVIDER}`);
  console.log(
    `Allowed origins: ${
      ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS.join(", ") : "any (development mode)"
    }`
  );
});

process.on("SIGINT", async () => {
  const dbClosePromise =
    dbProvider === "postgres" ? db?.end?.() : db?.close?.();

  await Promise.allSettled([
    redisEnabled ? redis.quit() : Promise.resolve(),
    redisEnabled ? redisPub.quit() : Promise.resolve(),
    redisEnabled ? redisSub.quit() : Promise.resolve(),
    dbClosePromise,
  ]);
  process.exit(0);
});


