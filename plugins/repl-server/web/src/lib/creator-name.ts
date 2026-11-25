/** Maps script `createdBy` binding/session ids to a human-readable client name. */

export type CreatorNames = ReadonlyMap<string, string>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

/**
 * `createdBy` is a binding id or an MCP session id. Bindings carry a label;
 * unbound sessions carry the client's self-reported name.
 */
export function creatorNamesFromClients(payload: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const root = asRecord(payload);
  if (root === null) return names;

  for (const entry of Array.isArray(root['clients']) ? root['clients'] : []) {
    const row = asRecord(entry);
    if (row === null) continue;
    const id = asText(row['id']);
    const label = asText(row['label']);
    if (id !== null && label !== null) names.set(id, label);
  }

  for (const entry of Array.isArray(root['sessions']) ? root['sessions'] : []) {
    const row = asRecord(entry);
    if (row === null) continue;
    const id = asText(row['mcpSessionId']);
    const label = asText(row['clientName']) ?? asText(row['client']);
    if (id !== null && label !== null) names.set(id, label);
  }

  return names;
}

/** Unknown ids stay readable instead of leaking internal codes into the table. */
export function creatorLabel(createdBy: string | null | undefined, names: CreatorNames): string | null {
  const value = createdBy?.trim();
  if (value === undefined || value === '') return null;
  if (value === 'admin') return '管理端';
  return names.get(value) ?? '未知客户端';
}
