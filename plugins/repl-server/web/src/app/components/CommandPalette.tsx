/** ⌘K palette: jump to a page or server without touching the sidebar. */
import { SearchOutlined } from '@ant-design/icons';
import { Input, Modal } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { useApi } from '../api.tsx';
import {
  filterPaletteItems,
  PALETTE_PAGES,
  serverItem,
  type PaletteItem,
} from '../../lib/command-palette.ts';

export function CommandPalette({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (item: PaletteItem) => void;
}): React.ReactElement {
  const api = useApi();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [servers, setServers] = useState<PaletteItem[]>([]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    let cancelled = false;
    void api
      .get<{ servers?: Array<{ id: string; label: string }> }>('/servers')
      .then((response) => {
        if (cancelled || !Array.isArray(response.servers)) return;
        setServers(response.servers.map(serverItem));
      })
      .catch(() => {
        // Pages remain navigable without the server list.
      });
    return () => {
      cancelled = true;
    };
  }, [api, open]);

  const items = useMemo(
    () => filterPaletteItems([...PALETTE_PAGES, ...servers], query).slice(0, 9),
    [query, servers],
  );

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      width={560}
      destroyOnHidden
      styles={{ header: { display: 'none' }, body: { padding: 0 } }}
      title={null}
      closable={false}
    >
      <Input
        autoFocus
        size="large"
        variant="borderless"
        prefix={<SearchOutlined />}
        placeholder="搜索页面或 server…"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (items.length === 0) return;
            setActive((current) => {
              const delta = event.key === 'ArrowDown' ? 1 : -1;
              return (current + delta + items.length) % items.length;
            });
          }
          if (event.key === 'Enter' && items[active] !== undefined) {
            event.preventDefault();
            onNavigate(items[active] as PaletteItem);
          }
        }}
      />
      <div className="palette-list" role="listbox">
        {items.length === 0 ? (
          <p className="palette-empty">没有匹配项</p>
        ) : (
          items.map((item, index) => (
            <button
              key={`${item.kind}-${item.label}-${index}`}
              type="button"
              role="option"
              aria-selected={index === active}
              className={`palette-item${index === active ? ' active' : ''}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => onNavigate(item)}
            >
              <span className="palette-kind">{item.kind}</span>
              <span className="palette-label">{item.label}</span>
              <span className="palette-hint">{item.hint}</span>
            </button>
          ))
        )}
      </div>
      <p className="palette-foot">
        <span>↑↓ 选择</span>
        <span>↵ 打开</span>
        <span>esc 关闭</span>
      </p>
    </Modal>
  );
}
