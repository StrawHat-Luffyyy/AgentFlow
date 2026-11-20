/** Parses the operator's receipt text: it must be a JSON object, as the API requires. */
export function parseReceipt(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, error: "The receipt must be a JSON object." };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, error: "The receipt is not valid JSON." };
  }
}
