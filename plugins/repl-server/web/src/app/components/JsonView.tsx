/** Foldable JSON viewer; non-JSON or truncated payloads stay on the textual pre fallback. */
import { JSONTree } from 'react-json-tree';

const THEME = {
  scheme: 'repl',
  author: 'repl-server',
  base00: 'var(--surface-inset)',
  base01: 'var(--surface)',
  base02: 'var(--border)',
  base03: 'var(--text-faint)',
  base04: 'var(--text-muted)',
  base05: 'var(--text)',
  base06: 'var(--text)',
  base07: 'var(--text)',
  base08: '#d4380d',
  base09: '#1971c2',
  base0A: '#7048e8',
  base0B: '#2f9e44',
  base0C: '#0c8599',
  base0D: '#7048e8',
  base0E: '#ae3ec9',
  base0F: '#e8590c',
};

export function JsonView({
  value,
  maxHeight = 260,
}: {
  value: unknown;
  maxHeight?: number | string;
}): React.ReactElement {
  return (
    <div className="json-view" style={{ maxHeight, overflow: 'auto' }}>
      <JSONTree
        data={value}
        theme={THEME}
        shouldExpandNodeInitially={(_keyPath, _data, level) => level < 2}
      />
    </div>
  );
}
