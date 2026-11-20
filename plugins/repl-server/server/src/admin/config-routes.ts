/** `/secrets` and `/config` routes not covered by the servers handler.
 *
 * `POST /config/import` accepts the declarative document exported by
 * `GET /config/export` plus an optional `dryRun` flag (the frozen design also
 * allows `?dry-run=true`). Validation and document normalization live in
 * {@link createConfigAdmin}; this module only translates the plan into HTTP:
 *
 * - dry-run answers `200 { valid, diff, errors?, missingSecrets? }` and never writes;
 * - an invalid document answers `400 INVALID_CONFIG` with the offending field paths;
 * - a valid import answers `200 { operationId, diff, missingSecrets? }` when it runs
 *   inline, or `202` when an operation registry defers it.
 *
 * List/config responses contain server ids and secret *key names* only. A
 * secret value leaves the process only through the explicit
 * `POST /secrets/:name/reveal` action requested by the admin UI.
 * @module
 */

import {
  ConfigValidationError,
  createConfigAdmin,
  type ConfigDiff,
  type ConfigImportIssue,
  type ConfigImportTarget,
  type ConfigRepository,
  type OperationStarter,
  type ServerConfigRecord,
} from './config.ts';
import {
  AdminApiError,
  adminHandler,
  adminJson,
  invalidField,
  nullIfBlank,
  queryValue,
  rejectUnknownFields,
  requestSegments,
  requireObjectBody,
  requiredSecretNames,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
  type OperationLauncher,
  type ServerConfig,
  type ServerConfigPatch,
  type ServerRecord,
  type ServerStore,
} from './servers.ts';
import { isValidSecretName, type SecretStore } from '../secrets/store.ts';

export interface AdminConfigRoutesDeps {
  secrets: SecretStore;
  servers: ServerStore;
  /**
   * Import writer. Assembly should inject an implementation that applies every
   * upsert/removal in one storage transaction. When omitted, the route adapts
   * {@link ServerStore} with a snapshot + compensating rollback, which restores
   * the previous rows on failure but is not atomic against a process crash.
   */
  importTarget?: ConfigImportTarget;
  /** 202-operation registry. Without it imports run inline and answer 200. */
  operations?: OperationStarter;
  /** Deterministic operation ids for tests and embedders. */
  newOperationId?: () => string;
}

const IMPORT_BODY_FIELDS: ReadonlySet<string> = new Set(['version', 'servers', 'dryRun']);
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONCURRENCY = 8;

/** `/secrets` and `/config` routes not covered by the servers handler. */
export function createAdminConfigRoutes(deps: AdminConfigRoutesDeps): AdminHandler {
  const admin = createConfigAdmin({
    repository: createServerStoreRepository(deps.servers),
    importTarget: deps.importTarget ?? createServerStoreImportTarget(deps.servers),
    secrets: deps.secrets,
    ...(deps.operations === undefined ? {} : { operations: deps.operations }),
    ...(deps.newOperationId === undefined ? {} : { newOperationId: deps.newOperationId }),
  });

  async function importConfig(request: AdminRequest): Promise<AdminResponse> {
    const body = requireObjectBody(request);
    rejectUnknownFields(body, IMPORT_BODY_FIELDS);
    const dryRun = readDryRunFlag(request, body);

    const document: Record<string, unknown> = {};
    if (body['version'] !== undefined) document['version'] = body['version'];
    if (body['servers'] !== undefined) document['servers'] = body['servers'];

    if (dryRun) {
      return adminJson(200, await admin.importConfig(document, { dryRun: true }));
    }

    // Preflight gives the response its diff and missing secret names, and turns
    // validation errors into a 400 with the offending field paths.
    const preflight = await admin.importConfig(document, { dryRun: true });
    if (!('diff' in preflight)) {
      throw new AdminApiError(500, 'IMPORT_FAILED', 'config preflight did not return a plan');
    }
    if (!preflight.valid) throw invalidConfig(preflight.errors ?? [], preflight.issues);

    let operationId: string;
    try {
      const result = await admin.importConfig(document);
      if (!('operationId' in result)) {
        throw new AdminApiError(500, 'IMPORT_FAILED', 'config import did not start');
      }
      operationId = result.operationId;
    } catch (error) {
      if (error instanceof ConfigValidationError) {
        throw invalidConfig(error.errors, error.issues);
      }
      throw error;
    }

    const response: { operationId: string; diff: ConfigDiff; missingSecrets?: string[] } = {
      operationId,
      diff: preflight.diff,
    };
    if (preflight.missingSecrets !== undefined) {
      response.missingSecrets = [...preflight.missingSecrets];
    }
    return adminJson(deps.operations === undefined ? 200 : 202, response);
  }

  return adminHandler(async (request): Promise<AdminResponse | null> => {
    const withoutPrefix = request.path.replace(/^\/admin\/api/, '');
    const queryStart = withoutPrefix.indexOf('?');
    const pathname = queryStart === -1 ? withoutPrefix : withoutPrefix.slice(0, queryStart);
    const path = pathname.replace(/\/+$/, '') || '/';
    const segments = requestSegments({ ...request, path });

    if (request.method === 'GET' && path === '/secrets') {
      const stored = new Set(await deps.secrets.listNames());
      const declared = new Set<string>();
      for (const server of await deps.servers.list()) {
        // Every env/header key is a declaration, whether it holds a literal or
        // a $secret reference; an arg declares a key only through a reference.
        for (const key of Object.keys(server.env)) declared.add(key);
        for (const key of Object.keys(server.headers)) declared.add(key);
        for (const name of requiredSecretNames(server)) declared.add(name);
      }
      const names = [...new Set([...stored, ...declared])].sort();
      return adminJson(200, {
        secrets: names.map((name) => ({ name, configured: stored.has(name) })),
      });
    }

    if (
      request.method === 'POST' &&
      segments.length === 3 &&
      segments[0] === 'secrets' &&
      segments[2] === 'reveal' &&
      segments[1] !== undefined
    ) {
      const name = segments[1];
      if (!isValidSecretName(name)) {
        throw invalidField('name', 'must be a valid secret name');
      }
      const value = await deps.secrets.get(name);
      if (value === undefined) {
        throw new AdminApiError(404, 'SECRET_NOT_FOUND', `secret ${name} is not set`, { name });
      }
      // The admin HTTP layer already sends no-store for every JSON response.
      return adminJson(200, { name, value });
    }

    if (request.method === 'PUT' && segments[0] === 'secrets' && segments[1] !== undefined) {
      const body = requireObjectBody(request);
      const value = body['value'];
      if (typeof value !== 'string' || value === '') {
        throw invalidField('value', 'must be a non-empty string');
      }
      await deps.secrets.set(segments[1], value);
      return adminJson(200, { name: segments[1], configured: true });
    }

    if (
      request.method === 'DELETE' &&
      segments.length === 2 &&
      segments[0] === 'secrets' &&
      segments[1] !== undefined
    ) {
      const name = segments[1];
      if (!isValidSecretName(name)) {
        throw invalidField('name', 'must be a valid secret name');
      }
      const deleted = (await deps.secrets.get(name)) !== undefined;
      await deps.secrets.delete(name);
      return adminJson(200, { name, deleted });
    }

    if (request.method === 'GET' && path === '/config/export') {
      // Sanitized document: secret refs become `<secret:name>` placeholders and
      // literal env/header values become null (design 03 §5; RS-11).
      return adminJson(200, await admin.exportConfig());
    }

    if (request.method === 'POST' && path === '/config/import') {
      return importConfig(request);
    }

    return null;
  });
}

/** Adapts the shared admin operation launcher to the config import registry. */
export function operationStarterFromLauncher(launcher: OperationLauncher): OperationStarter {
  return {
    start(input) {
      return launcher.launch(input.kind, input.target ?? 'config', input.run).operationId;
    },
  };
}

function readDryRunFlag(request: AdminRequest, body: Record<string, unknown>): boolean {
  const raw = body['dryRun'];
  if (raw !== undefined) {
    if (typeof raw !== 'boolean') throw invalidField('dryRun', 'must be a boolean');
    return raw;
  }

  const fromQuery = queryValue(request, 'dry-run');
  if (fromQuery === null || fromQuery === '') return false;
  if (fromQuery === 'true' || fromQuery === '1') return true;
  if (fromQuery === 'false' || fromQuery === '0') return false;
  throw new AdminApiError(400, 'INVALID_QUERY', 'dry-run must be true or false', {
    parameter: 'dry-run',
  });
}

function invalidConfig(
  errors: readonly string[],
  issues?: readonly ConfigImportIssue[],
): AdminApiError {
  const fields: string[] = [];
  for (const message of errors) {
    const field = fieldOf(message);
    if (!fields.includes(field)) fields.push(field);
  }
  // Discovery validation carries its own 422 code (07 §2.3 / A-17); map it so
  // an import failure is indistinguishable from the same error on PATCH.
  const discoveryIssue = issues?.find(
    (issue) =>
      issue.code === 'DISCOVERY_SECRET_NOT_ALLOWED' ||
      issue.code === 'DISCOVERY_CONFIG_INVALID',
  );
  if (discoveryIssue?.code !== undefined) {
    return new AdminApiError(
      422,
      discoveryIssue.code,
      `config import rejected: ${errors.join('; ')}`,
      {
        ...(discoveryIssue.details ?? {}),
        fields,
        errors: [...errors],
      },
    );
  }
  return new AdminApiError(
    400,
    'INVALID_CONFIG',
    `config import rejected: ${errors.join('; ')}`,
    { fields, errors: [...errors] },
  );
}

/** Extracts `servers[0].command`-style paths from normalization messages. */
function fieldOf(message: string): string {
  const head = message.split(/[:\s]/, 1)[0] ?? '';
  if (/^(?:servers(?:\[|\.)|config(?:\.|$)|version$)/.test(head)) return head;
  if (message.startsWith('duplicate server id')) return 'servers';
  if (message.includes('config version')) return 'version';
  return 'servers';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function createServerStoreRepository(servers: ServerStore): ConfigRepository {
  return {
    listServers: () => servers.list(),
    getServer: (id) => servers.get(id),
  };
}

function cloneArgs(
  args: ServerConfigRecord['args'],
): Array<string | { $secret: string }> {
  return (args ?? []).map((arg) =>
    typeof arg === 'string' ? arg : { $secret: arg.$secret },
  );
}

function cloneField(
  field: ServerConfigRecord['env'],
): Record<string, string | { $secret: string }> {
  const result: Record<string, string | { $secret: string }> = {};
  for (const [key, value] of Object.entries(field ?? {})) {
    result[key] = typeof value === 'string' ? value : { $secret: value.$secret };
  }
  return result;
}

function configFromRecord(
  record: ServerConfigRecord,
  summarySource?: string | null,
): ServerConfig {
  return {
    id: record.id,
    label: record.label,
    transport: record.transport,
    command: record.command ?? null,
    args: cloneArgs(record.args),
    env: cloneField(record.env),
    cwd: record.cwd ?? null,
    url: record.url ?? null,
    headers: cloneField(record.headers),
    enabled: record.enabled ?? true,
    connectMode: record.connectMode ?? 'eager',
    summary: record.summary ?? null,
    summarySource:
      summarySource !== undefined
        ? summarySource
        : record.summary == null
          ? null
          : 'manual',
    category: record.category ?? null,
    tags: [...(record.tags ?? [])],
    timeoutMs: record.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxConcurrency: record.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    ...(record.toolDiscovery === undefined ? {} : { toolDiscovery: record.toolDiscovery }),
  };
}

/**
 * Source recorded for an imported summary: an unchanged summary keeps its
 * provenance, a changed one is a manual edit and an absent one has no source.
 */
function summarySourceForImport(
  desired: ServerConfigRecord,
  current: ServerRecord | null,
): string | null {
  const summary = desired.summary ?? null;
  if (current !== null && (current.summary ?? null) === summary) return current.summarySource;
  return summary === null ? null : 'manual';
}

function patchFromRecord(record: ServerConfigRecord): ServerConfigPatch {
  return {
    label: record.label,
    command: record.command ?? null,
    args: cloneArgs(record.args),
    env: cloneField(record.env),
    cwd: record.cwd ?? null,
    url: record.url ?? null,
    headers: cloneField(record.headers),
    enabled: record.enabled ?? true,
    connectMode: record.connectMode ?? 'eager',
    summary: record.summary ?? null,
    category: record.category ?? null,
    tags: [...(record.tags ?? [])],
    timeoutMs: record.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxConcurrency: record.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    ...(record.toolDiscovery === undefined ? {} : { toolDiscovery: record.toolDiscovery }),
  };
}

interface RollbackState {
  created: string[];
  replaced: ServerRecord[];
  updated: ServerRecord[];
  removed: ServerRecord[];
}

/**
 * Fallback import writer over {@link ServerStore}. `ServerStore` has no bulk
 * transaction, so every write is tracked and undone on failure. Assembly should
 * inject a real single-transaction target when one exists.
 */
function createServerStoreImportTarget(servers: ServerStore): ConfigImportTarget {
  return {
    async applyImport(input): Promise<void> {
      const snapshot = new Map<string, ServerRecord>();
      for (const record of await servers.list()) snapshot.set(record.id, record);

      const state: RollbackState = {
        created: [],
        replaced: [],
        updated: [],
        removed: [],
      };

      try {
        for (const entry of input.upserts) {
          // A blank summary is "no summary" on every write path, so every
          // downstream create/patch and source comparison sees null.
          const desired: ServerConfigRecord = {
            ...entry,
            summary: nullIfBlank(entry.summary),
          };
          const current = await servers.get(desired.id);
          if (current === null) {
            await servers.create(configFromRecord(desired));
            state.created.push(desired.id);
            continue;
          }

          const previous = snapshot.get(desired.id) ?? current;
          if (current.transport !== desired.transport) {
            // `ServerStore.update` cannot change transport, so the row is replaced.
            await servers.remove(desired.id, await servers.revision());
            await servers.create(
              configFromRecord(desired, summarySourceForImport(desired, current)),
            );
            state.replaced.push(previous);
            continue;
          }

          // `ServerStore.update` can express "set discovery" but not "unset";
          // an old document without toolDiscovery therefore replaces the row,
          // which is also how the fallback handles a transport change.
          const desiredDiscovery = desired.toolDiscovery ?? null;
          const currentDiscovery = current.toolDiscovery ?? null;
          if (desiredDiscovery === null && currentDiscovery !== null) {
            await servers.remove(desired.id, await servers.revision());
            await servers.create(
              configFromRecord(desired, summarySourceForImport(desired, current)),
            );
            state.replaced.push(previous);
            continue;
          }

          const patch = patchFromRecord(desired);
          // A changed summary is a manual edit; an unchanged one keeps its
          // provenance (for example an AI-authored summary).
          if ((desired.summary ?? null) !== (current.summary ?? null)) {
            patch.summarySource = summarySourceForImport(desired, current);
          }
          await servers.update(desired.id, patch, await servers.revision());
          state.updated.push(previous);
        }

        for (const id of input.removals) {
          const previous = snapshot.get(id);
          if (previous === undefined) continue;
          await servers.remove(id, await servers.revision());
          state.removed.push(previous);
        }
      } catch (error) {
        const rollbackErrors = await rollbackImport(servers, state);
        if (rollbackErrors.length > 0) {
          throw new AdminApiError(
            500,
            'IMPORT_ROLLBACK_FAILED',
            `config import failed (${messageOf(error)}) and rollback was incomplete: ${rollbackErrors.join('; ')}`,
            { cause: messageOf(error), rollbackErrors },
          );
        }
        throw error;
      }
    },
  };
}

async function rollbackImport(
  servers: ServerStore,
  state: RollbackState,
): Promise<string[]> {
  const errors: string[] = [];
  const attempt = async (label: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (error) {
      errors.push(`${label}: ${messageOf(error)}`);
    }
  };

  for (const id of state.created) {
    await attempt(`remove ${id}`, async () => {
      if ((await servers.get(id)) !== null) {
        await servers.remove(id, await servers.revision());
      }
    });
  }

  for (const previous of [...state.replaced, ...state.removed]) {
    await attempt(`restore ${previous.id}`, async () => {
      if ((await servers.get(previous.id)) !== null) {
        await servers.remove(previous.id, await servers.revision());
      }
      await servers.create(configFromRecord(previous, previous.summarySource));
    });
  }

  for (const previous of state.updated) {
    await attempt(`restore ${previous.id}`, async () => {
      if ((await servers.get(previous.id)) === null) {
        await servers.create(configFromRecord(previous, previous.summarySource));
        return;
      }
      const patch = patchFromRecord(previous);
      patch.summarySource = previous.summarySource;
      await servers.update(previous.id, patch, await servers.revision());
    });
  }

  return errors;
}
