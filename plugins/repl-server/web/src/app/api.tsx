/** One API client for the React tree; pages read it through `useApi`. */
import { createContext, useContext } from 'react';

import { createApiClient, type ApiClient } from '../lib/api.ts';

export const api: ApiClient = createApiClient({
  onUnauthorized: () => {
    // The shell shows a reconnect banner; pages surface their own request errors.
    window.dispatchEvent(new CustomEvent('repl:unauthorized'));
  },
});

const ApiContext = createContext<ApiClient>(api);

export function ApiProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return <ApiContext.Provider value={api}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  return useContext(ApiContext);
}

/** Hydrates the CSRF token for cookie sessions; Bearer tokens do not need it. */
export async function hydrateCsrf(): Promise<void> {
  try {
    const response = await api.get<{ csrfToken?: unknown }>('/csrf');
    if (typeof response.csrfToken === 'string') api.setCsrfToken(response.csrfToken);
  } catch {
    // A missing endpoint is fine for token-only deployments.
  }
}
