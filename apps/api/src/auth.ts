import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { z } from "zod";

export const credentialSchema = z.object({
  id: z.string().min(1).max(200).refine((id) => id !== "legacy-unassigned"),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  roles: z.array(z.string().min(1).max(100)),
  expiresAt: z.string().datetime().optional(),
});
export type Credential = z.infer<typeof credentialSchema>;

export function readCredentials(value = process.env.AGENTFLOW_AUTH_CREDENTIALS): Credential[] {
  const credentials = z.array(credentialSchema).parse(JSON.parse(value ?? "[]"));
  if (new Set(credentials.map((entry) => entry.tokenHash)).size !== credentials.length) {
    throw new Error("Duplicate authentication token hashes");
  }
  return credentials;
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
