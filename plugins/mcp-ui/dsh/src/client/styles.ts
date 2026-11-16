/**
 * Stylesheet of the MCP page. It uses the host's `--dsw-*` theme variables, so light and dark
 * themes follow the app; the fallbacks only apply if a variable is missing. @module
 */
const STYLE_ID = 'mcp-ui-styles';

const TEXT = 'var(--dsw-alias-label-primary, #1d1d1f)';
const MUTED = 'var(--dsw-alias-label-tertiary, #8a8a8f)';
const BORDER = 'var(--dsw-alias-border-l3, rgba(128,128,128,.28))';
const CARD_FILL = 'var(--dsw-alias-settings-card-fill, transparent)';
const CARD_STROKE = 'var(--dsw-alias-settings-card-stroke, rgba(128,128,128,.28))';
const HOVER = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.12))';
const ACCENT = 'var(--dsw-alias-state-business-primary, #247bbf)';
const ERROR = 'var(--dsw-alias-state-error-primary, #d64545)';
const OK = '#2f9e5b';
const WARN = '#d98a1b';

export const MCP_CSS = `
/* The settings panel is 800x800 in DSH. Make it use more of the window; the selector is the panel's stable data attribute. */
[data-shortcut-modal="settings"]{width:min(1280px,calc(100vw - 96px)) !important;height:calc(100vh - 2 * max(24px, var(--dsh-frame-overlay-top, 24px))) !important;max-width:calc(100vw - 48px) !important}
.mcp-page{width:100%;max-width:none;color:${TEXT};display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:20px}
.mcp-page h2{margin:0;font-size:18px;line-height:26px}
.mcp-notes{margin:0;padding:6px 12px;border:.5px solid ${CARD_STROKE};border-radius:10px;background:${HOVER};color:${MUTED};font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mcp-list{display:flex;flex-direction:column;gap:12px}
.mcp-card{border:.5px solid ${CARD_STROKE};border-radius:12px;background:${CARD_FILL};padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.mcp-card[data-enabled=false]{opacity:.65}
.mcp-card-head{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap}
.mcp-controls{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;margin-left:auto}
.mcp-card-title{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.mcp-name{font-size:15px;line-height:22px;word-break:break-all}
.mcp-tag{padding:0 8px;border:.5px solid ${BORDER};border-radius:999px;color:${MUTED};font-size:12px;line-height:18px}
.mcp-dot{width:8px;height:8px;border-radius:50%;background:${MUTED};flex:none}
.mcp-dot[data-tone=ok]{background:${OK}}
.mcp-dot[data-tone=warn]{background:${WARN}}
.mcp-dot[data-tone=error]{background:${ERROR}}
.mcp-status{color:${MUTED}}
.mcp-status[data-tone=ok]{color:${OK}}
.mcp-status[data-tone=warn]{color:${WARN}}
.mcp-status[data-tone=error]{color:${ERROR}}
.mcp-switch,.mcp-check{display:inline-flex;align-items:center;gap:6px;cursor:pointer;white-space:nowrap;color:${MUTED}}
.mcp-hint{margin:0;color:${MUTED};font-size:12px}
.mcp-empty{margin:0;padding:10px 0;color:${MUTED}}
.mcp-tools{display:flex;flex-direction:column;gap:6px;border-top:.5px solid ${BORDER};padding-top:6px}
.mcp-page button.mcp-card-fold{border:0;background:transparent;padding:2px 6px;margin:-2px -6px;color:inherit;text-align:left;cursor:pointer;border-radius:8px}
.mcp-page button.mcp-card-fold:hover{background:${HOVER}}
.mcp-chevron{width:10px;display:inline-block;color:${MUTED}}
.mcp-tool-list{margin:0;padding:0;list-style:none;display:flex;flex-direction:column}
.mcp-tool{display:flex;align-items:flex-start;gap:12px;padding:8px;border-radius:8px;justify-content:space-between}
.mcp-tool-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.mcp-tool-desc{margin:0;color:${MUTED};font-size:12px;line-height:18px;white-space:pre-wrap;word-break:break-word}
.mcp-tool:hover{background:${HOVER}}
.mcp-tool-muted{opacity:.55}
.mcp-tool-actions{display:flex;align-items:center;gap:12px;flex-shrink:0}
.mcp-tool-name{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;word-break:break-all}
.mcp-page button{font:inherit;color:${TEXT};background:transparent;border:.5px solid ${BORDER};border-radius:8px;padding:4px 12px;cursor:pointer}
.mcp-page button:hover{background:${HOVER}}
.mcp-page button:focus-visible{outline:2px solid ${ACCENT};outline-offset:1px}
.mcp-page button.mcp-danger{color:${ERROR};border-color:${ERROR}}
.mcp-errors{margin:0;padding:8px 12px;border-radius:8px;color:${ERROR};background:${HOVER};list-style:none}
.mcp-form{display:flex;flex-direction:column;gap:10px;border:.5px solid ${CARD_STROKE};border-radius:12px;padding:14px 16px}
.mcp-field{display:flex;flex-direction:column;gap:4px;color:${MUTED}}
.mcp-field.mcp-inline,.mcp-inline{flex-direction:row;align-items:center;gap:6px}
.mcp-field input:not([type=checkbox]),.mcp-field textarea,.mcp-field select{font:inherit;color:${TEXT};background:transparent;border:.5px solid ${BORDER};border-radius:8px;padding:6px 10px}
.mcp-field textarea{min-height:64px;resize:vertical}
.mcp-field input:focus-visible,.mcp-field textarea:focus-visible,.mcp-field select:focus-visible{outline:2px solid ${ACCENT};outline-offset:0}
`;

/**
 * Add the stylesheet to the document once.
 * @returns a function that removes it, for the effect cleanup.
 */
export function installStyles(): () => void {
  const doc = (globalThis as { document?: { getElementById(id: string): unknown; createElement(tag: string): { id: string; textContent: string }; head: { appendChild(node: unknown): void; removeChild(node: unknown): void } } }).document;
  if (doc === undefined || doc.getElementById(STYLE_ID) !== null) return () => {};
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = MCP_CSS;
  doc.head.appendChild(style);
  return () => { doc.head.removeChild(style); };
}
