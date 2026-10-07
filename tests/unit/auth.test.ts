import { describe, expect, it } from "vitest";
import {
  hashPassword,
  parseCookies,
  sessionCookieOptions,
  verifyPassword,
} from "../../apps/api/src/auth.js";

describe("server-side credential authentication & session helpers", () => {
  it("hashes passwords with unique random salts using scrypt", () => {
    const password = "correct-horse-battery-staple";
    const hash1 = hashPassword(password);
    const hash2 = hashPassword(password);

    expect(hash1).not.toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
    expect(hash2).toMatch(/^[a-f0-9]{32}:[a-f0-9]{128}$/);
  });

  it("verifies matching passwords and rejects incorrect passwords", () => {
    const password = "my-secure-password-123";
    const hash = hashPassword(password);

    expect(verifyPassword(password, hash)).toBe(true);
    expect(verifyPassword("wrong-password", hash)).toBe(false);
    expect(verifyPassword("", hash)).toBe(false);
    expect(verifyPassword("My-secure-password-123", hash)).toBe(false);
  });

  it("rejects malformed stored password hashes", () => {
    expect(verifyPassword("password", "")).toBe(false);
    expect(verifyPassword("password", "invalid-hash")).toBe(false);
    expect(verifyPassword("password", "salt_without_separator")).toBe(false);
  });

  it("parses cookies correctly from cookie headers", () => {
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("agentflow_session=abcdef123456")).toEqual({
      agentflow_session: "abcdef123456",
    });
    expect(
      parseCookies("theme=dark; agentflow_session=token-xyz; other=value%201"),
    ).toEqual({
      theme: "dark",
      agentflow_session: "token-xyz",
      other: "value 1",
    });
  });

  it("enforces secure httpOnly session cookie options", () => {
    expect(sessionCookieOptions.httpOnly).toBe(true);
    expect(sessionCookieOptions.sameSite).toBe("lax");
    expect(sessionCookieOptions.path).toBe("/");
    expect(sessionCookieOptions.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });
});
