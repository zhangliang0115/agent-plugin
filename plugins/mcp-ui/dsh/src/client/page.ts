/**
 * The MCP left-nav page. It loads the manager's servers and this plugin's
 * parallel list, follows the manager's status stream, and runs each write
 * against the revision it last read. @module
 */
import { parseToolsPayload } from './tools-payload.ts';
import {
  buildServerRows,
  maskValue,
  toggleDisabled,
  toggleParallel,
  type ServerRow,
  type ServerToolsView,
} from '@zhangliang0115/mcp-ui-core';
import {
  readSettings,
  settingsFailureMessage,
  writeDisabledTools,
  writeParallelTools,
  writeServerChange,
  type RemoteResult,
  type SettingsSnapshot,
} from './remote.ts';
import { draftFromEntry, draftToForm, emptyDraft, entryForForm, type ServerDraft } from './draft.ts';
import { createServerForm } from './form.ts';
import { createServerRow } from './rows.ts';
import type { ClientContext, ReactLike } from './types.ts';

/** What the form is editing: a new server, or the named existing one. */
type EditTarget = { readonly kind: 'new' } | { readonly kind: 'edit'; readonly name: string };

const READ_ONLY_NOTICE = '当前配置只读，无法修改 MCP 服务器';
/** One line above the list; the separator keeps the three notes readable side by side. */
const PAGE_NOTE = '并行开关仅在 Code Mode 预设下生效 · 修改服务器会重建实例 · 凭据用 ${credential:REF} 引用';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isFailure(result: unknown): result is { ok: false; error: { message: string; code?: string } } {
  return typeof result === 'object' && result !== null && (result as { ok?: unknown }).ok === false;
}

/**
 * @param react - the React functions from the module loader.
 * @param ctx - the client context carrying the remote namespaces.
 * @returns the section component for the settings navigation.
 */
export function createMcpSection(react: ReactLike, ctx: ClientContext): () => unknown {
  const h = react.createElement;
  const Row = createServerRow(react);
  const Form = createServerForm(react);

  return function McpSection(): unknown {
    const [snapshot, setSnapshot] = react.useState<RemoteResult<SettingsSnapshot> | undefined>(undefined);
    const [views, setViews] = react.useState<ServerToolsView[]>([]);
    const [notice, setNotice] = react.useState<string | undefined>(undefined);
    const [editing, setEditing] = react.useState<EditTarget | undefined>(undefined);
    const [draft, setDraft] = react.useState<ServerDraft>(emptyDraft());
    const [formErrors, setFormErrors] = react.useState<string[]>([]);

    const reload = async (): Promise<void> => {
      try {
        setSnapshot(await readSettings(ctx.remote.settings));
      } catch (error) {
        setNotice(messageOf(error));
      }
    };

    react.useEffect(() => {
      void reload();
      return ctx.remote.$on('settings/document-updated', () => { void reload(); });
    }, []);

    react.useEffect(() => {
      const controller = new AbortController();
      void (async () => {
        try {
          for await (const payload of ctx.remote.mcpTools.watch(controller.signal)) {
            const servers = parseToolsPayload(payload);
            if (servers === undefined) setNotice('收到的服务器列表格式不对，已忽略这一次更新');
            else setViews(servers);
          }
        } catch (error) {
          if (!controller.signal.aborted) setNotice(messageOf(error));
        }
      })();
      return () => controller.abort();
    }, []);

    const loaded = snapshot?.ok === true ? snapshot.value : undefined;
    const rows: ServerRow[] = loaded === undefined ? [] : buildServerRows(loaded.servers, views);

    /** Run one settings write, then refresh the page from the host. */
    const writeSettings = async (action: () => Promise<RemoteResult<unknown>>): Promise<boolean> => {
      const result = await action();
      if (result.ok) {
        setNotice(undefined);
        await reload();
        return true;
      }
      setNotice(settingsFailureMessage(result.error));
      await reload();
      return false;
    };

    const requireLoaded = (): SettingsSnapshot | undefined => {
      if (loaded === undefined) setNotice('配置还没有加载完成，请稍后再试');
      else if (!loaded.writable) setNotice(READ_ONLY_NOTICE);
      return loaded !== undefined && loaded.writable ? loaded : undefined;
    };

    const saveServer = async (submitted: ServerDraft): Promise<void> => {
      const current = requireLoaded();
      if (current === undefined || editing === undefined) return;
      const result = draftToForm(submitted);
      if (!result.ok) {
        setFormErrors(result.errors);
        return;
      }
      const name = result.form.name;
      if (editing.kind === 'new' && name in current.servers) {
        setFormErrors([`已存在名为「${name}」的服务器`]);
        return;
      }
      const saved = await writeSettings(() => writeServerChange(ctx.remote.settings, current.serversRevision, {
        kind: 'upsert',
        name,
        entry: entryForForm(result.form),
      }));
      if (saved) {
        setEditing(undefined);
        setFormErrors([]);
      }
    };

    const removeServer = (name: string): Promise<boolean> | undefined => {
      const current = requireLoaded();
      if (current === undefined) return undefined;
      return writeSettings(() => writeServerChange(ctx.remote.settings, current.serversRevision, { kind: 'remove', name }));
    };

    const setEnabled = (name: string, enabled: boolean): void => {
      const current = requireLoaded();
      if (current === undefined) return;
      void writeSettings(() => writeServerChange(ctx.remote.settings, current.serversRevision, { kind: 'enabled', name, enabled }));
    };

    const restart = async (name: string): Promise<void> => {
      try {
        const result = await ctx.remote.mcpManager.restart(name);
        if (isFailure(result)) setNotice(settingsFailureMessage(result.error));
        else setNotice(undefined);
      } catch (error) {
        setNotice(messageOf(error));
      }
    };

    const toggleTool = (pattern: string, enabled: boolean): void => {
      const current = requireLoaded();
      if (current === undefined) return;
      const next = toggleParallel(current.parallelTools, pattern, enabled);
      void writeSettings(() => writeParallelTools(ctx.remote.settings, current.parallelRevision, next));
    };

    const toggleDisabledTool = (fullName: string, disabled: boolean): void => {
      const current = requireLoaded();
      if (current === undefined) return;
      const result = toggleDisabled(current.disabledTools, fullName, disabled);
      if (!result.ok) {
        setNotice(`${fullName} 由 ${result.cover} 禁用，不能单独启用`);
        return;
      }
      void writeSettings(() => writeDisabledTools(ctx.remote.settings, current.parallelRevision, result.list));
    };

    const maskedKeys = (name: string): string[] => {
      const entry = loaded?.servers[name];
      if (entry === undefined) return [];
      const values = { ...entry.env, ...entry.headers };
      return Object.keys(values).filter(key => maskValue(values[key] ?? '') !== (values[key] ?? ''));
    };

    const rowElements = rows.map((row) => {
      const entry = loaded?.servers[row.name];
      return h(Row, {
        key: row.name,
        row,
        masked: maskedKeys(row.name),
        parallelTools: loaded?.parallelTools ?? [],
        disabledTools: loaded?.disabledTools ?? [],
        server: views.find(view => view.name === row.name),
        onToggleEnabled: (enabled: boolean) => setEnabled(row.name, enabled),
        onRestart: () => { void restart(row.name); },
        onEdit: () => {
          if (entry === undefined) return;
          setDraft(draftFromEntry(row.name, entry));
          setFormErrors([]);
          setEditing({ kind: 'edit', name: row.name });
        },
        onDelete: () => { void removeServer(row.name); },
        onToggleTool: toggleTool,
        onToggleDisabled: toggleDisabledTool,
      });
    });

    const loadError = snapshot !== undefined && snapshot.ok === false ? snapshot.error.message : undefined;
    return h('div', { className: 'mcp-page' },
      h('h2', null, 'MCP 服务器'),
      h('p', { className: 'mcp-notes' }, PAGE_NOTE),
      loadError === undefined ? null : h('p', { className: 'mcp-errors', role: 'alert' }, loadError),
      notice === undefined ? null : h('p', { className: 'mcp-errors', role: 'alert' }, notice),
      loaded !== undefined && !loaded.writable ? h('p', null, READ_ONLY_NOTICE) : null,
      editing === undefined
        ? h('button', {
          type: 'button',
          onClick: () => {
            setDraft(emptyDraft());
            setFormErrors([]);
            setEditing({ kind: 'new' });
          },
        }, '添加服务器')
        : h(Form, {
          key: editing.kind === 'new' ? 'new' : `edit-${editing.name}`,
          initial: draft,
          isNew: editing.kind === 'new',
          errors: formErrors,
          onSave: (next: ServerDraft) => { setDraft(next); void saveServer(next); },
          onCancel: () => setEditing(undefined),
        }),
      rowElements.length === 0 && loaded !== undefined
        ? h('p', null, '还没有 MCP 服务器。')
        : h('div', { className: 'mcp-list' }, ...rowElements));
  };
}
