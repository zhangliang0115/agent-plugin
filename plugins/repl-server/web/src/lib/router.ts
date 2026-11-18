/** Hash-based SPA router for the admin shell (`#/overview`, `#/audit`, `#/manage`).
 *
 * Routes may act as section prefixes: `/audit` also owns `/audit/evals/7`, and the
 * location reports the remaining segments so the next stage can resolve detail views.
 * Unknown or empty hashes are replaced by the fallback route.
 *
 * The environment (location/history/listeners) is injectable, so the router can be
 * exercised without a browser; the default is `window`.
 * @module
 */

export interface RouteLocation {
  /** Full normalized path, for example `/audit/evals/7`. */
  path: string;
  /** The registered route that owns `path`, for example `/audit`. */
  route: string;
  /** Segments below `route`; empty at the route root. */
  segments: readonly string[];
  /** Parsed query string. */
  query: URLSearchParams;
  /** Raw hash as it appeared in the address bar, without the leading `#`. */
  hash: string;
}

export type QueryInput =
  | Record<string, string | number | boolean | null | undefined>
  | URLSearchParams;

export interface NavigateOptions {
  replace?: boolean;
  query?: QueryInput;
}

/** The slice of `window` the router needs. */
export interface RouterEnvironment {
  readonly location: { hash: string };
  readonly history: {
    pushState(data: unknown, unused: string, url?: string | null): void;
    replaceState(data: unknown, unused: string, url?: string | null): void;
  };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface RouterOptions {
  /** Registered route paths such as `/overview`; a leading slash is added when missing. */
  routes: readonly string[];
  /** Route used for an empty or unknown hash; must be registered. */
  fallback: string;
  /** Called on start, navigation and popstate/hashchange. */
  onChange(location: RouteLocation): void;
  /** Defaults to `window`. */
  environment?: RouterEnvironment;
}

export interface HashRouter {
  readonly routes: readonly string[];
  start(): void;
  stop(): void;
  navigate(path: string, options?: NavigateOptions): void;
  current(): RouteLocation;
}

/** Normalizes `overview`, `#/overview/` and `/overview?x=1` to `/overview`. */
export function normalizePath(path: string): string {
  let value = path.trim();
  if (value.startsWith('#')) value = value.slice(1);
  const queryIndex = value.indexOf('?');
  if (queryIndex !== -1) value = value.slice(0, queryIndex);
  if (value === '') return '/';
  if (!value.startsWith('/')) value = `/${value}`;
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/** Longest registered route equal to `path` or a parent of it; `null` when none matches. */
export function matchRoute(path: string, routes: readonly string[]): string | null {
  let best: string | null = null;
  for (const candidate of routes) {
    const route = normalizePath(candidate);
    if (path === route || path.startsWith(`${route}/`)) {
      if (best === null || route.length > best.length) best = route;
    }
  }
  return best;
}

/** Parses a hash into a location; `route` falls back to the path when nothing matches. */
export function parseHash(hash: string, routes: readonly string[] = []): RouteLocation {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const queryIndex = raw.indexOf('?');
  const path = normalizePath(queryIndex === -1 ? raw : raw.slice(0, queryIndex));
  const query = new URLSearchParams(queryIndex === -1 ? '' : raw.slice(queryIndex + 1));
  const matched = matchRoute(path, routes);
  const route = matched ?? path;
  const segments =
    matched === null || path === matched
      ? []
      : path.slice(matched.length + 1).split('/').filter((segment) => segment !== '');
  return { path, route, segments, query, hash: raw };
}

export function createHashRouter(options: RouterOptions): HashRouter {
  const routes = options.routes.map(normalizePath);
  const fallback = normalizePath(options.fallback);
  if (!routes.includes(fallback)) {
    throw new Error(`hash router: fallback ${fallback} is not a registered route`);
  }

  const environment = options.environment ?? defaultEnvironment();
  let started = false;
  let lastHash: string | null = null;
  let currentLocation = parseHash(environment.location.hash, routes);

  function handleHash(rawHash: string): void {
    const location = parseHash(rawHash, routes);
    if (matchRoute(location.path, routes) === null) {
      navigate(fallback, { replace: true });
      return;
    }
    lastHash = rawHash;
    currentLocation = location;
    options.onChange(location);
  }

  function onLocationChange(): void {
    if (environment.location.hash === lastHash) return;
    handleHash(environment.location.hash);
  }

  function navigate(path: string, navigateOptions: NavigateOptions = {}): void {
    const raw = path.startsWith('#') ? path.slice(1) : path;
    const queryIndex = raw.indexOf('?');
    const params = new URLSearchParams(queryIndex === -1 ? '' : raw.slice(queryIndex + 1));
    appendQuery(params, navigateOptions.query);
    const search = params.toString();
    const hash = `#${normalizePath(queryIndex === -1 ? raw : raw.slice(0, queryIndex))}${
      search === '' ? '' : `?${search}`
    }`;

    if (navigateOptions.replace === true) environment.history.replaceState(null, '', hash);
    else environment.history.pushState(null, '', hash);
    handleHash(hash);
  }

  function start(): void {
    if (started) {
      handleHash(environment.location.hash);
      return;
    }
    started = true;
    environment.addEventListener('hashchange', onLocationChange);
    environment.addEventListener('popstate', onLocationChange);
    handleHash(environment.location.hash);
  }

  function stop(): void {
    if (!started) return;
    started = false;
    environment.removeEventListener('hashchange', onLocationChange);
    environment.removeEventListener('popstate', onLocationChange);
  }

  return {
    routes,
    start,
    stop,
    navigate,
    current: () => currentLocation,
  };
}

function appendQuery(params: URLSearchParams, query?: QueryInput): void {
  if (query === undefined) return;
  if (query instanceof URLSearchParams) {
    for (const [key, value] of query) params.append(key, value);
    return;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
}

function defaultEnvironment(): RouterEnvironment {
  if (typeof window === 'undefined') {
    throw new Error('hash router: pass `environment` when `window` is unavailable');
  }
  return window as unknown as RouterEnvironment;
}
