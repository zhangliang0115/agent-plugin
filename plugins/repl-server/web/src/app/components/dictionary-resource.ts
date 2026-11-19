/** Loads a dictionary endpoint once per session; shared by tags and categories. */
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import type { DictionaryEntry } from '../../lib/dictionary.ts';

export interface DictionaryResource {
  entries: DictionaryEntry[];
  revision: number;
  loading: boolean;
  reload(): Promise<void>;
}

const cache = new Map<string, { entries: DictionaryEntry[]; revision: number }>();

/** Fetches `GET <endpoint>` and reads the dictionary from `field`; failures degrade to empty. */
export function useDictionaryResource(endpoint: string, field: string): DictionaryResource {
  const api = useApi();
  const [state, setState] = useState(() => cache.get(endpoint) ?? { entries: [], revision: 0 });
  const [loading, setLoading] = useState(!cache.has(endpoint));

  const reload = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const response = await api.get<Record<string, unknown>>(endpoint);
      const raw = response[field];
      const entries = Array.isArray(raw) ? (raw as DictionaryEntry[]) : [];
      const revision = typeof response['revision'] === 'number' ? response['revision'] : 0;
      cache.set(endpoint, { entries, revision });
      setState({ entries, revision });
    } catch {
      cache.set(endpoint, { entries: [], revision: 0 });
      setState({ entries: [], revision: 0 });
    } finally {
      setLoading(false);
    }
  }, [api, endpoint, field]);

  useEffect(() => {
    if (!cache.has(endpoint)) void reload();
  }, [endpoint, reload]);

  return { entries: state.entries, revision: state.revision, loading, reload };
}
