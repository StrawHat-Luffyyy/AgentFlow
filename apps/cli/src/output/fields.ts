/** Renders aligned `key  value` lines for detail views. */
export function renderFields(fields: Array<[string, string]>): string {
  const width = Math.max(...fields.map(([key]) => key.length));
  return fields.map(([key, value]) => `${key.padEnd(width)}  ${value}`).join("\n");
}
