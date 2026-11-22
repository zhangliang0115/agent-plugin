/**
 * Startup seed for the five protocol tools under `__builtin__`.
 *
 * These rows are admin-page metadata only. `buildCatalogSnapshot` excludes
 * `__builtin__` until composite tools get a script executor, so seeding them
 * does not add `run_script`/`search_tools`/... to `search_tools`,
 * `describe_tools`, or the `visibleTools` surface.
 *
 * @module
 */

import type { DatabaseSync } from 'node:sqlite';

import { withTransaction } from '../db/migrate.ts';
import { bumpRevision } from '../db/meta.ts';
import { BUILTIN_SERVER_ID } from '../db/servers.ts';
import { refreshServerIndex, seedTool } from '../db/tools.ts';
import { listTools } from './registry.ts';

export interface BuiltinSeedResult {
  inserted: number;
  filled: number;
}

/** Idempotent; the revision moves when a row was inserted, filled or refreshed. */
export function seedBuiltinTools(db: DatabaseSync): BuiltinSeedResult {
  return withTransaction(db, () => {
    const result: BuiltinSeedResult = { inserted: 0, filled: 0 };
    for (const definition of listTools()) {
      const outcome = seedTool(
        db,
        BUILTIN_SERVER_ID,
        {
          name: definition.name,
          description: definition.description,
          inputSchema: definition.inputSchema,
        },
        { refresh: true },
      );
      if (outcome === 'inserted') result.inserted += 1;
      else if (outcome === 'filled') result.filled += 1;
    }
    if (result.inserted + result.filled > 0) {
      refreshServerIndex(db, BUILTIN_SERVER_ID);
      bumpRevision(db);
    }
    return result;
  });
}
