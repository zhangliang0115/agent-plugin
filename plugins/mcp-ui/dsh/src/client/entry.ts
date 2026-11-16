/**
 * Browser entry. Mounts this package's `mcpTools` remote, then registers the MCP section and its icon
 * in the settings navigation. The bundle is a plain script: running it only registers the factory,
 * and the factory runs on first use. @module
 */
import { mcpToolsRemote } from '../mcp-tools-remote.ts';
import { createMcpIcon } from './icon.ts';
import { createMcpSection } from './page.ts';
import { installStyles } from './styles.ts';
import type { ClientContext, ModuleLoaderLike, ReactLike } from './types.ts';

/** Package name; the loader row id for this bundle. */
const PACKAGE_ID = '@zhangliang0115/mcp-ui';
/** Left-nav id, shared by the section and its icon. */
const SECTION_ID = 'mcp';
/** Position after the built-in sections. */
const SECTION_ORDER = 30;

declare const window: { __ModuleLoader__: ModuleLoaderLike };

window.__ModuleLoader__.load({
  id: PACKAGE_ID,
  factory(require) {
    const react = require('react') as ReactLike;
    return {
      inject: ['slots', 'remote'],
      apply(ctx: ClientContext): void {
        // The `mcpTools` namespace does not exist until this mount finishes, so the section lives in a
        // second plugin that waits for it through `inject`.
        ctx.plugin({
          name: 'mcp-ui-remote',
          inject: ['remote'],
          apply: (child: ClientContext) => child.remote.$mount(mcpToolsRemote),
        });
        ctx.plugin({
          name: 'mcp-ui-section',
          inject: ['slots', 'remote', 'remote.settings', 'remote.mcpManager', 'remote.mcpTools'],
          apply(child: ClientContext): () => void {
            const McpSection = createMcpSection(react, child);
            const McpIcon = createMcpIcon(react);
            child.slots.inject('settings.section', () => child.slots.register({
              name: 'settings.section',
              id: SECTION_ID,
              order: SECTION_ORDER,
              label: () => 'MCP',
            }, McpSection));
            child.slots.inject('settings.section.icon', () => child.slots.register({
              name: 'settings.section.icon',
              id: SECTION_ID,
            }, McpIcon));
            // Page styles and the larger settings panel apply as soon as the plugin is up.
            return installStyles();
          },
        });
      },
    };
  },
});
