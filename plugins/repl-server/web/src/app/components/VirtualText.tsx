/**
 * Windowed text renderer for large bodies (`09 §五`).
 *
 * One DOM row per source line, but only the viewport (plus a fixed buffer) is
 * ever mounted — a 50 MB log costs the same DOM as a 10 KB snippet, and the
 * mounted row count stays far below the 5000-row ceiling the design sets.
 * Search highlighting is per visible row; the match counter lives in the
 * parent, which also owns the search string.
 */
import { useState } from 'react';

import {
  highlightParts,
  VIRTUAL_ROW_HEIGHT,
  virtualWindow,
  type TextLine,
} from '../../lib/text-view.ts';

export function VirtualText({
  lines,
  maxHeight,
  rowHeight = VIRTUAL_ROW_HEIGHT,
  search = '',
}: {
  lines: TextLine[];
  maxHeight: number;
  rowHeight?: number;
  search?: string;
}): React.ReactElement {
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = typeof maxHeight === 'number' ? maxHeight : 320;
  const window = virtualWindow(scrollTop, viewport, rowHeight, lines.length);
  const visible = lines.slice(window.start, window.end);

  return (
    <div
      className="vtext mono"
      style={{ maxHeight, overflow: 'auto' }}
      onScroll={(event) => {
        setScrollTop(event.currentTarget.scrollTop);
      }}
    >
      <div style={{ height: lines.length * rowHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: window.start * rowHeight, left: 0, right: 0 }}>
          {visible.map((line, index) => (
            <div
              key={window.start + index}
              className={`vtext-line${line.kind === 'plain' ? '' : ` diff-${line.kind}`}`}
              style={{ height: rowHeight }}
            >
              {/* Sign column keeps the diff readable without relying on colour. */}
              <span className="vtext-sign">
                {line.kind === 'del' ? '−' : line.kind === 'add' ? '+' : ' '}
              </span>
              {search === '' ? (
                line.text === '' ? '\u00a0' : line.text
              ) : (
                highlightParts(line.text, search).map((part, partIndex) =>
                  part.hit ? (
                    <mark key={partIndex} className="vtext-hit">
                      {part.text}
                    </mark>
                  ) : (
                    <span key={partIndex}>{part.text === '' ? '\u00a0' : part.text}</span>
                  ),
                )
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
