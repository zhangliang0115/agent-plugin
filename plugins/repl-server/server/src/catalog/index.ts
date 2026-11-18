/**
 * Catalog service: FTS effective-column maintenance, immutable snapshots and
 * `catalog_changed` notifications. @module
 */
import type { DatabaseSync } from 'node:sqlite';

import type { Catalog, CatalogSnapshot } from '../ports.ts';
import { getClientBinding } from '../db/clients.ts';
import { refreshServerIndex } from '../db/tools.ts';
import {
  buildCatalogSnapshot,
  bumpCatalogRevision,
  readCatalogRevision,
  readNumberColumn,
} from './snapshot.ts';
import { searchTools } from './search.ts';
import type { SearchHit, SearchRequest } from './search.ts';

export {
  buildCatalogSnapshot,
  bumpCatalogRevision,
  parseStringArray,
  readCatalogRevision,
} from './snapshot.ts';
export {
  BM25_WEIGHTS,
  SEARCH_DEFAULT_MAX,
  SEARCH_MAX_LIMIT,
  expandQueryTerms,
  parseSearchQuery,
  searchTools,
  toFtsMatch,
} from './search.ts';
export type {
  ParsedSearchQuery,
  SearchCategoryOverview,
  SearchHit,
  SearchOutcome,
  SearchRequest,
  SearchServerOverview,
  SearchVisibility,
} from './search.ts';

/**
 * Recomputes the effective index columns for one server, scoped by
 * `server_id`; the `tools_au` trigger then syncs `tools_fts`.
 *
 * The write paths in `db/tools.ts` already call the same helper in their
 * transactions, so this is the single implementation of the effective-column
 * rules (override, server summary, tag union). A full
 * `INSERT INTO tools_fts(tools_fts) VALUES('rebuild')` stays reserved for
 * migrations and startup repair.
 * @returns number of tool rows refreshed for the server
 * @module
 */
export function refreshFts(db: DatabaseSync, serverId: string): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM tools WHERE server_id = ?')
    .get(serverId);
  refreshServerIndex(db, serverId);
  return row === undefined ? 0 : readNumberColumn(row as Record<string, unknown>, 'n');
}

/** Event broadcast after the catalog snapshot is rebuilt. @module */
export interface CatalogChangedEvent {
  revision: number;
  servers: string[];
}

export type CatalogChangedListener = (event: CatalogChangedEvent) => void;

export interface CatalogServiceOptions {
  db: DatabaseSync;
  /** Optional initial `catalog_changed` subscriber, e.g. the SSE hub. */
  onCatalogChanged?: CatalogChangedListener;
}

/** Read-only snapshot access plus explicit rebuild/commit hooks. @module */
export interface CatalogService extends Catalog {
  snapshot(): CatalogSnapshot;
  revision(): number;
  /**
   * Rebuilds from the committed SQLite state. Notifies listeners when
   * `meta.revision` moved or when `changedServers` is non-empty.
   */
  rebuild(changedServers?: readonly string[]): CatalogSnapshot;
  /**
   * Bumps `meta.revision`, rebuilds and always notifies. Call after a write
   * transaction that did not go through a ConfigStore revision bump.
   */
  commit(changedServers?: readonly string[]): CatalogSnapshot;
  /**
   * Recomputes `tools.index_*` for one server, then rebuilds and notifies.
   * The caller is expected to have already committed the write (and bumped
   * the revision) in its own transaction.
   */
  refreshServer(serverId: string): CatalogSnapshot;
  /** Bound alias for the design's `refreshFts(serverId)`. */
  refreshFts(serverId: string): CatalogSnapshot;
  onCatalogChanged(listener: CatalogChangedListener): () => void;
}

function uniqueServerIds(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}

/**
 * Creates the catalog service around an already-migrated SQLite connection.
 * The initial snapshot is built eagerly so `snapshot()` is always valid.
 * @module
 */
export function createCatalogService(options: CatalogServiceOptions): CatalogService {
  const { db } = options;
  let current = buildCatalogSnapshot(db);
  const listeners = new Set<CatalogChangedListener>();
  if (options.onCatalogChanged !== undefined) listeners.add(options.onCatalogChanged);

  function notify(event: CatalogChangedEvent): void {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        // A broken subscriber (SSE client, test spy) must not fail a catalog commit.
        console.error('repl-server: catalog_changed listener failed', error);
      }
    }
  }

  function rebuild(changedServers: readonly string[] = []): CatalogSnapshot {
    const previousRevision = current.revision;
    const revision = Math.max(previousRevision, readCatalogRevision(db));
    const next = buildCatalogSnapshot(db, revision);
    current = next;
    const servers = uniqueServerIds(changedServers);
    if (next.revision > previousRevision || servers.length > 0) {
      notify({ revision: next.revision, servers });
    }
    return next;
  }

  function refreshServer(serverId: string): CatalogSnapshot {
    refreshFts(db, serverId);
    return rebuild([serverId]);
  }

  return {
    snapshot: () => current,
    revision: () => current.revision,
    rebuild,
    commit(changedServers: readonly string[] = []): CatalogSnapshot {
      const revision = Math.max(current.revision, bumpCatalogRevision(db));
      const next = buildCatalogSnapshot(db, revision);
      current = next;
      notify({ revision: next.revision, servers: uniqueServerIds(changedServers) });
      return next;
    },
    refreshServer,
    refreshFts: refreshServer,
    onCatalogChanged(listener: CatalogChangedListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** `GET /admin/api/search` input, structurally matching the admin SearchPreview port. @module */
export interface SearchPreviewInput {
  query: string;
  server?: string;
  category?: string;
  tag?: string;
  type?: string;
  max: number;
  bindingId?: string;
}

export interface SearchPreviewResult {
  results: SearchHit[];
  notice?: string;
}

export interface BindingVisibility {
  allowedServers: readonly string[] | null;
  allowedTags: readonly string[] | null;
}

export interface SearchPreviewOptions {
  db: DatabaseSync;
  /**
   * Resolves a binding id to its visibility. Defaults to `client_bindings`;
   * tests and the admin handler can inject their own lookup.
   */
  findBinding?: (bindingId: string) => BindingVisibility | null;
}

/** The admin search-preview port; same retriever as `search_tools`. @module */
export interface SearchPreview {
  search(input: SearchPreviewInput): SearchPreviewResult;
}

/**
 * Builds the admin `GET /admin/api/search` preview around the same FTS
 * retriever used by `search_tools`. Without `bindingId` it is the unfiltered
 * admin view; with one, results are filtered by that binding's any-of
 * `allowed_servers` / `allowed_tags`.
 * @module
 */
export function createSearchPreview(options: SearchPreviewOptions): SearchPreview {
  const findBinding =
    options.findBinding
    ?? ((bindingId: string): BindingVisibility | null => {
      const binding = getClientBinding(options.db, bindingId);
      if (binding === null) return null;
      return {
        allowedServers: binding.allowedServers,
        allowedTags: binding.allowedTags,
      };
    });

  function overviewHit(server: {
    server: string;
    kind: 'builtin' | 'mcp';
    tags: string[];
    toolCount: number;
  }): SearchHit {
    const callForm =
      server.kind === 'builtin'
        ? 'tools.<tool>(args)'
        : `tools.mcp.${server.server}.<tool>(args)`;
    const hit: SearchHit = {
      name: server.server,
      kind: server.kind,
      description:
        `${server.toolCount} tool${server.toolCount === 1 ? '' : 's'}; call ${callForm}`,
    };
    if (server.kind === 'mcp') hit.server = server.server;
    if (server.tags.length > 0) hit.tags = [...server.tags];
    return hit;
  }

  return {
    search(input: SearchPreviewInput): SearchPreviewResult {
      const request: SearchRequest = { query: input.query, max: input.max };
      if (input.server !== undefined) request.server = input.server;
      if (input.category !== undefined) request.category = input.category;
      if (input.tag !== undefined) request.tags = [input.tag];
      if (input.type !== undefined) request.type = input.type;

      if (input.bindingId !== undefined) {
        const binding = findBinding(input.bindingId);
        if (binding === null) {
          return {
            results: [],
            notice: `binding ${input.bindingId} does not exist`,
          };
        }
        request.visibility = {
          allowedServers: binding.allowedServers,
          allowedTags: binding.allowedTags,
        };
      }

      const outcome = searchTools(options.db, request);
      const results: SearchHit[] =
        outcome.overview === undefined
          ? outcome.results
          : outcome.overview.servers.map(overviewHit);
      const result: SearchPreviewResult = { results };
      if (outcome.hints.length > 0) result.notice = outcome.hints.join(' ');
      return result;
    },
  };
}
