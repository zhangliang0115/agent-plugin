/** Accumulating option lists for admin filter dropdowns. */

export interface LabeledOption {
  value: string;
  label: string;
}

export function listOptions(values: readonly string[]): LabeledOption[] {
  return values.map((value) => ({ value, label: value }));
}

/** Returns the previous array when nothing new was added, so React skips the update. */
export function mergeValues(previous: readonly string[], added: readonly string[]): string[] {
  const next = new Set(previous);
  let changed = false;
  for (const value of added) {
    if (value === '' || next.has(value)) continue;
    next.add(value);
    changed = true;
  }
  return changed ? [...next].sort((left, right) => left.localeCompare(right)) : (previous as string[]);
}

export function mergeBindings(
  previous: readonly LabeledOption[],
  added: readonly LabeledOption[],
): LabeledOption[] {
  const byValue = new Map(previous.map((entry) => [entry.value, entry]));
  let changed = false;
  for (const entry of added) {
    if (entry.value === '') continue;
    const existing = byValue.get(entry.value);
    // A real label from `/clients` or `/servers` upgrades an id-only fallback.
    if (existing === undefined) {
      byValue.set(entry.value, entry);
      changed = true;
    } else if (existing.label === existing.value && entry.label !== entry.value) {
      byValue.set(entry.value, entry);
      changed = true;
    }
  }
  return changed
    ? [...byValue.values()].sort((left, right) => left.value.localeCompare(right.value))
    : (previous as LabeledOption[]);
}
