import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { Database } from "@agentflow/db";
import { z } from "zod";

export const credentialSchema = z.object({
  id: z.string().min(1).max(200).refine((id) => id !== "legacy-unassigned"),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  roles: z.array(z.string().min(1).max(100)),
  expiresAt: z.string().datetime().optional(),
});
export type Credential = z.infer<typeof credentialSchema>;

export interface AuthenticatedPrincipal {
  id: string;
  roles: string[];
  username?: string;
}

export function readCredentials(value = process.env.AGENTFLOW_AUTH_CREDENTIALS): Credential[] {
  const credentials = z.array(credentialSchema).parse(JSON.parse(value ?? "[]"));
  if (new Set(credentials.map((entry) => entry.tokenHash)).size !== credentials.length) {
    throw new Error("Duplicate authentication token hashes");
  }
  return credentials;
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derivedKey}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) return false;
  const derivedKey = scryptSync(password, salt, 64);
  const keyBuffer = Buffer.from(key, "hex");
  if (derivedKey.length !== keyBuffer.length) return false;
  return timingSafeEqual(derivedKey, keyBuffer);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eqIdx = part.indexOf("=");
    if (eqIdx !== -1) {
      const key = part.slice(0, eqIdx).trim();
      const value = part.slice(eqIdx + 1).trim();
      if (key) {
        try {
          cookies[key] = decodeURIComponent(value);
        } catch {
          cookies[key] = value;
        }
      }
    }
  }
  return cookies;
}

export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000,
};

export async function ensureAdminUser(
  database: Database,
  password?: string,
  username = "admin",
): Promise<void> {
  if (!password) return;
  const passwordHash = hashPassword(password);
  await database.query(
    `INSERT INTO web_users (id, username, password_hash, roles, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET
       username = EXCLUDED.username,
       password_hash = EXCLUDED.password_hash,
       roles = EXCLUDED.roles,
       updated_at = NOW()`,
    ["acceptance-owner", username, passwordHash, ["research-reviewer", "operator"]],
  );
}

export function bearerAuthentication(credentials: readonly Credential[]): RequestHandler {
  return (request, response, next) => {
    const match = /^Bearer ([^\s]+)$/i.exec(request.header("authorization") ?? "");
    if (!match) {
      response.setHeader("WWW-Authenticate", "Bearer");
      response.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }
    const digest = createHash("sha256").update(match[1]!).digest();
    const principal = credentials.find((entry) =>
      timingSafeEqual(digest, Buffer.from(entry.tokenHash, "hex")) &&
      (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()),
    );
    if (!principal) {
      response.status(401).json({ error: "UNAUTHENTICATED" });
      return;
    }
    response.locals.principal = principal;
    next();
  };
}

export function authenticationMiddleware(
  database: Database,
  credentials: readonly Credential[],
): RequestHandler {
  return async (request, response, next) => {
    const authHeader = request.header("authorization");
    if (authHeader) {
      const match = /^Bearer ([^\s]+)$/i.exec(authHeader);
      if (!match) {
        response.setHeader("WWW-Authenticate", "Bearer");
        response.status(401).json({ error: "UNAUTHENTICATED" });
        return;
      }
      const digest = createHash("sha256").update(match[1]!).digest();
      const principal = credentials.find((entry) =>
        timingSafeEqual(digest, Buffer.from(entry.tokenHash, "hex")) &&
        (!entry.expiresAt || Date.parse(entry.expiresAt) > Date.now()),
      );
      if (!principal) {
        response.status(401).json({ error: "UNAUTHENTICATED" });
        return;
      }
      response.locals.principal = { id: principal.id, roles: principal.roles };
      return next();
    }

    const cookies = parseCookies(request.header("cookie"));
    const sessionId = cookies["agentflow_session"];
    if (sessionId) {
      const result = await database.query<{
        id: string;
        username: string;
        roles: string[];
        expires_at: Date;
      }>(
        `SELECT u.id, u.username, u.roles, s.expires_at
         FROM web_sessions s
         JOIN web_users u ON u.id = s.user_id
         WHERE s.id = $1 AND s.expires_at > NOW()`,
        [sessionId],
      );
      if (result.rowCount && result.rows[0]) {
        const user = result.rows[0];
        response.locals.principal = {
          id: user.id,
          roles: user.roles,
          username: user.username,
        };
        return next();
      }
      response.clearCookie("agentflow_session", { path: "/" });
    }

    response.setHeader("WWW-Authenticate", "Bearer");
    response.status(401).json({ error: "UNAUTHENTICATED" });
  };
}
