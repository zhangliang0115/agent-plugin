import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export const HOSTS = ['claude-code', 'dsh', 'pi'] as const;
export type Host = (typeof HOSTS)[number];

export const STATUSES = ['supported', 'experimental', 'unsupported'] as const;
export type Status = (typeof STATUSES)[number];

export interface HostEntry {
  status: Status;
  reason?: string;
  components?: string[];
}

export interface PluginMeta {
  id: string;
  version: string;
  description: string;
  hosts: Partial<Record<Host, HostEntry>>;
}

export interface LoadedPlugin {
  dirName: string;
  meta: PluginMeta;
}

export type ValidationResult =
  | { ok: true; meta: PluginMeta }
  | { ok: false; errors: string[] };

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * 按 docs/architecture.md 的 plugin.meta.json 格式校验一份已解析的元数据。
 * `hasAdapterDir` 告诉校验器某个宿主的 adapter 目录是否存在。
 */
export function validatePluginMeta(
  dirName: string,
  raw: unknown,
  hasAdapterDir: (host: Host) => boolean,
): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ['顶层必须是 JSON 对象'] };
  }

  const { id, version, description, hosts } = raw;

  if (!isNonEmptyString(id)) {
    errors.push('id 必须是非空字符串');
  } else {
    if (!KEBAB_CASE.test(id)) {
      errors.push(`id ${JSON.stringify(id)} 必须是 kebab-case`);
    }
    if (id !== dirName) {
      errors.push(`id ${JSON.stringify(id)} 必须等于目录名 ${JSON.stringify(dirName)}`);
    }
  }

  if (!isNonEmptyString(version)) errors.push('version 必须是非空字符串');
  if (!isNonEmptyString(description)) errors.push('description 必须是非空字符串');

  if (!isRecord(hosts)) {
    errors.push('hosts 必须是对象');
  } else {
    for (const [host, entry] of Object.entries(hosts)) {
      if (!(HOSTS as readonly string[]).includes(host)) {
        errors.push(`hosts.${host}: 宿主必须是 ${HOSTS.join(' / ')} 之一`);
        continue;
      }
      if (!isRecord(entry)) {
        errors.push(`hosts.${host}: 必须是对象`);
        continue;
      }

      const { status, reason } = entry;
      if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
        errors.push(
          `hosts.${host}.status: ${JSON.stringify(status)} 不合法，必须是 ${STATUSES.join(' / ')} 之一`,
        );
        continue;
      }

      if (status === 'unsupported') {
        if (!isNonEmptyString(reason)) {
          errors.push(`hosts.${host}: status 为 unsupported 时必须写 reason`);
        }
      } else if (!hasAdapterDir(host as Host)) {
        errors.push(`hosts.${host}: status 为 ${status} 时必须有 ${dirName}/${host}/ 目录`);
      }

      const { components } = entry;
      if (
        components !== undefined &&
        !(Array.isArray(components) && components.every((item) => typeof item === 'string'))
      ) {
        errors.push(`hosts.${host}.components: 必须是字符串数组`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, meta: raw as unknown as PluginMeta };
}

export interface LoadResult {
  plugins: LoadedPlugin[];
  errors: string[];
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 读取 `<root>/plugins/<id>/plugin.meta.json`，按目录名排序。`plugins/` 不存在时返回空结果。 */
export async function loadPlugins(root: string): Promise<LoadResult> {
  const pluginsDir = join(root, 'plugins');
  const plugins: LoadedPlugin[] = [];
  const errors: string[] = [];

  let dirNames: string[];
  try {
    dirNames = (await readdir(pluginsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { plugins, errors };
    }
    throw error;
  }

  for (const dirName of dirNames) {
    const metaRel = `plugins/${dirName}/plugin.meta.json`;
    const pluginDir = join(pluginsDir, dirName);

    let text: string;
    try {
      text = await readFile(join(pluginDir, 'plugin.meta.json'), 'utf8');
    } catch {
      errors.push(`${metaRel}: 缺少 plugin.meta.json`);
      continue;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      errors.push(`${metaRel}: JSON 解析失败：${(error as Error).message}`);
      continue;
    }

    const hostDirs = new Map<Host, boolean>();
    for (const host of HOSTS) {
      hostDirs.set(host, await isDirectory(join(pluginDir, host)));
    }

    const result = validatePluginMeta(dirName, raw, (host) => hostDirs.get(host) ?? false);
    if (result.ok) {
      plugins.push({ dirName, meta: result.meta });
    } else {
      for (const message of result.errors) errors.push(`${metaRel}: ${message}`);
    }
  }

  return { plugins, errors };
}
