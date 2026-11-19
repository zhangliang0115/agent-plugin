/** Shared shape and pure helpers for the tag/category dictionaries. */
export interface DictionaryEntry {
  key: string;
  zh: string;
  en: string;
}

/** Chinese label for a stored key; unknown keys fall back to the raw value. */
export function dictionaryLabel(entries: readonly DictionaryEntry[], key: string): string {
  return entries.find((entry) => entry.key === key)?.zh ?? key;
}

export interface DictionaryOption {
  value: string;
  label: string;
}

/** Select options with `中文 / English`; a saved unknown key stays selectable as “未登记”. */
export function dictionarySelectOptions(
  entries: readonly DictionaryEntry[],
  current?: string | null,
): DictionaryOption[] {
  const options: DictionaryOption[] = entries.map((entry) => ({
    value: entry.key,
    label: `${entry.zh} / ${entry.en}`,
  }));
  if (
    typeof current === 'string' &&
    current !== '' &&
    !entries.some((entry) => entry.key === current)
  ) {
    options.unshift({ value: current, label: `${current}（未登记）` });
  }
  return options;
}
