/** AI service shutdown: close delegates to the runner once and stays idempotent. */
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import type { AiRunner } from '../src/ai/runner.ts';
import { createAiService } from '../src/ai/service.ts';
import { DbServerStore, DbSettingsStore, DbToolStore } from '../src/assembly-stores.ts';
import { openStateDb } from '../src/db/migrate.ts';

test('AiService.close closes the runner once and is idempotent', async (t) => {
  const db: DatabaseSync = openStateDb(':memory:');
  t.after(() => db.close());

  let closes = 0;
  const runner: AiRunner = {
    run: () => new Promise(() => undefined),
    close: async () => {
      closes += 1;
    },
  };
  const service = createAiService({
    db,
    servers: new DbServerStore(db),
    tools: new DbToolStore(db),
    settings: new DbSettingsStore(db),
    catalog: { rebuild: () => undefined },
    runner,
  });

  await Promise.all([service.close(), service.close()]);
  await service.close();
  assert.equal(closes, 1);
});
