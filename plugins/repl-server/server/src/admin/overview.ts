import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

import { adminJson, type AdminHandler } from './servers.ts';
import type { InFlightEvalsView } from '../ports.ts';
import type { ResourceSnapshot } from './resources.ts';

export interface BindingActivity {
  /** Client binding id; `null` groups unbound clients. */
  binding: string | null;
  /** Display label from `client_bindings`; null for unbound clients. */
  label?: string | null;
  execSessions: number;
  inFlightEvals: number;
  inFlightCalls: number;
  queuedCalls: number;
}

export interface OverviewSnapshot {
  capacity: Record<string, number>;
  pool: { total: number; ready: number; reconnecting: number; failed: number };
  sessions: { transport: number; exec: number; inFlightEvals: number };
  servers: { total: number; enabled: number };
  /** Live per-binding counters; optional so existing overview stubs still work. */
  bindings?: BindingActivity[];
  /** Process-tree memory/CPU samples; optional so existing overview stubs still work. */
  resources?: ResourceSnapshot;
  /** Live in-flight evals; omitted when the gateway is not wired. */
  evals?: InFlightEvalsView;
}

export interface AdminOverviewDeps {
  overview(): OverviewSnapshot;
  csrfToken?: () => string;
  /** Directory containing the built admin UI (server/dist/web). */
  staticDir?: string;
  /** Live in-flight evals; omitted when the gateway is not wired. */
  evals?: () => InFlightEvalsView;
  /** Aborts one live eval; false when it already settled. */
  cancelEval?: (exec: string, evalId: number) => boolean | Promise<boolean>;
}

/** `/evals/:exec/:evalId/cancel`, matched after the `/admin/api` prefix is stripped. */
const EVAL_CANCEL_PATH = /^\/evals\/([^/]+)\/(\d+)\/cancel$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

async function readStatic(staticDir: string, pathname: string): Promise<{ body: Buffer; type: string } | null> {
  const root = await realpath(staticDir).catch(() => resolve(staticDir));
  const relative = pathname.replace(/^\/admin\/?/, '');
  const candidate = normalize(join(root, relative === '' ? 'index.html' : relative));
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;

  const target = await stat(candidate).catch(() => null);
  if (target !== null && target.isFile()) {
    return { body: await readFile(candidate), type: MIME[extname(candidate)] ?? 'application/octet-stream' };
  }

  if (!relative.includes('.')) {
    const index = join(root, 'index.html');
    const fallback = await stat(index).catch(() => null);
    if (fallback !== null && fallback.isFile()) {
      return { body: await readFile(index), type: MIME['.html'] ?? 'text/html' };
    }
  }
  return null;
}

/** Serves `/overview`, `/csrf` and the static admin SPA. @module */
export function createAdminOverviewHandler(deps: AdminOverviewDeps): AdminHandler {
  return async (request) => {
    const path = request.path.replace(/^\/admin\/api/, '').replace(/\/+$/, '') || '/';

    if (request.method === 'GET' && path === '/overview') {
      const snapshot = deps.overview();
      return adminJson(
        200,
        deps.evals === undefined ? snapshot : { ...snapshot, evals: deps.evals() },
      );
    }

    if (request.method === 'POST') {
      const match = EVAL_CANCEL_PATH.exec(path);
      if (match !== null) {
        const rawExec = match[1] ?? '';
        let exec = rawExec;
        try {
          exec = decodeURIComponent(rawExec);
        } catch {
          // A malformed escape can only name an eval that does not exist.
        }
        const evalId = Number(match[2]);
        if (
          deps.cancelEval !== undefined &&
          exec !== '' &&
          Number.isSafeInteger(evalId) &&
          evalId > 0 &&
          (await deps.cancelEval(exec, evalId))
        ) {
          return adminJson(200, { ok: true });
        }
        return adminJson(404, {
          error: {
            code: 'EVAL_NOT_FOUND',
            message: `eval ${match[2]} is not in flight in ${exec}`,
          },
        });
      }
    }

    if (request.method === 'GET' && path === '/csrf') {
      if (deps.csrfToken === undefined) return null;
      return adminJson(200, { csrfToken: deps.csrfToken() });
    }

    const isApiPath =
      request.path.startsWith('/admin/api') ||
      request.path === '/api' ||
      request.path.startsWith('/api/');
    if (request.method === 'GET' && deps.staticDir !== undefined && !isApiPath) {
      const file = await readStatic(deps.staticDir, path).catch(() => null);
      if (file !== null) {
        return {
          status: 200,
          headers: { 'content-type': file.type, 'cache-control': 'no-cache' },
          body: file.body,
        };
      }
    }

    return null;
  };
}

/** Ensures the static root exists so a missing build does not crash `/health`. */
export async function ensureStaticDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}
