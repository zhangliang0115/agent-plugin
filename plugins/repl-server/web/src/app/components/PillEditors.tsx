/** Popover pill editors used by the server/tool list columns. */
import { Button, Checkbox, Input, Popover, Tag } from 'antd';
import { DownOutlined, EditOutlined, SearchOutlined } from '@ant-design/icons';
import { useState } from 'react';

import {
  dictionaryLabel,
  dictionarySelectOptions,
  type DictionaryEntry,
} from '../../lib/dictionary.ts';
import { tagLabel, type TagDefinition } from './TagPicker.tsx';

/** Single-select category pill; a pick applies and closes immediately. */
export function CategoryPillEditor({
  value,
  dictionary,
  onChange,
  disabled = false,
}: {
  value?: string | null;
  dictionary: readonly DictionaryEntry[];
  onChange: (next: string) => void;
  disabled?: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const current = value ?? '';
  const needle = query.trim().toLowerCase();
  const options = dictionarySelectOptions(dictionary, current).filter((option) =>
    `${option.value} ${option.label}`.toLowerCase().includes(needle),
  );

  function handleOpenChange(next: boolean): void {
    if (disabled) return;
    setOpen(next);
    setQuery('');
  }

  function choose(next: string): void {
    setOpen(false);
    if (next !== current) onChange(next);
  }

  return (
    <Popover
      trigger="click"
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      placement="bottomLeft"
      content={
        <div className="pill-popover" onClick={(event) => event.stopPropagation()}>
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索分类"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="pill-options">
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`pill-option${option.value === current ? ' active' : ''}`}
                onClick={() => choose(option.value)}
              >
                {option.label}
              </button>
            ))}
            {options.length === 0 ? <p className="pill-empty">没有匹配的分类</p> : null}
          </div>
          <div className="pill-popover-foot">
            <Button size="small" disabled={current === ''} onClick={() => choose('')}>
              清除分类
            </Button>
          </div>
        </div>
      }
    >
      <Tag
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        className={`tag-editor${disabled ? ' tag-editor-disabled' : ''}`}
        title={disabled ? '正在保存…' : current === '' ? '选择分类' : current}
        color={current === '' ? undefined : 'blue'}
        bordered={current === ''}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleOpenChange(!open);
          }
        }}
      >
        {current === '' ? '设置分类' : dictionaryLabel(dictionary, current)}
        <DownOutlined className="tag-editor-caret" />
      </Tag>
    </Popover>
  );
}

/** Multi-select tag pill: local draft, committed only by 完成. */
export function TagPillEditor({
  value,
  inherited = [],
  dictionary,
  onChange,
  disabled = false,
  maxVisible = 3,
  clearLabel = '清空标签',
}: {
  value: string[];
  inherited?: readonly string[];
  dictionary: readonly TagDefinition[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  maxVisible?: number;
  clearLabel?: string;
}): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<string[]>([]);

  // Effective tags are server.tags ∪ tool.tags; a tag explicitly set on the tool
  // is shown as editable blue, so inherited only shows the grey remainder.
  const pills = [
    ...value.map((key) => ({ key, inherited: false })),
    ...inherited.filter((tag) => !value.includes(tag)).map((key) => ({ key, inherited: true })),
  ];
  const visible = pills.slice(0, maxVisible);
  const hidden = pills.slice(maxVisible);

  const draftInherited = inherited.filter((tag) => !draft.includes(tag));
  const known = new Set(dictionary.map((tag) => tag.key));
  const needle = query.trim().toLowerCase();
  const options = [
    ...dictionary.map((tag) => ({
      key: tag.key,
      label: `${tag.zh} / ${tag.en}`,
      haystack: `${tag.key} ${tag.zh} ${tag.en}`,
    })),
    ...draft
      .filter((key) => !known.has(key))
      .map((key) => ({ key, label: `${key}（未登记）`, haystack: key })),
  ].filter((option) => option.haystack.toLowerCase().includes(needle));

  function handleOpenChange(next: boolean): void {
    if (disabled) return;
    if (next) {
      setDraft([...value]);
      setQuery('');
    }
    setOpen(next);
  }

  function toggle(key: string, checked: boolean): void {
    setDraft((prev) => {
      if (checked) return prev.includes(key) ? prev : [...prev, key];
      return prev.filter((entry) => entry !== key);
    });
  }

  function commit(): void {
    setOpen(false);
    const changed =
      draft.length !== value.length || draft.some((key) => !value.includes(key));
    if (changed) onChange(draft);
  }

  return (
    <Popover
      trigger="click"
      open={open && !disabled}
      onOpenChange={handleOpenChange}
      placement="bottomLeft"
      content={
        <div className="pill-popover" onClick={(event) => event.stopPropagation()}>
          <Input
            size="small"
            allowClear
            prefix={<SearchOutlined />}
            placeholder="搜索标签"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {inherited.length === 0 ? null : (
            <div className="pill-inherited">
              <span className="pill-popover-label">继承自 server（只读）</span>
              <div>
                {draftInherited.length === 0 ? (
                  <span className="muted">已全部在工具标签中</span>
                ) : (
                  draftInherited.map((tag) => (
                    <Tag key={tag} bordered={false} title={tag} style={{ marginInlineEnd: 4 }}>
                      {tagLabel(dictionary, tag)}
                    </Tag>
                  ))
                )}
              </div>
            </div>
          )}
          <div className="pill-options">
            {options.map((option) => (
              <label key={option.key} className="pill-check">
                <Checkbox
                  checked={draft.includes(option.key)}
                  onChange={(event) => toggle(option.key, event.target.checked)}
                />
                <span>{option.label}</span>
              </label>
            ))}
            {options.length === 0 ? <p className="pill-empty">没有匹配的标签</p> : null}
          </div>
          <div className="pill-popover-foot">
            <Button size="small" onClick={() => setDraft([])}>
              {clearLabel}
            </Button>
            <Button size="small" type="primary" onClick={commit}>
              完成
            </Button>
          </div>
        </div>
      }
    >
      <span
        role="button"
        tabIndex={disabled ? -1 : 0}
        aria-disabled={disabled || undefined}
        className={`tag-editor${disabled ? ' tag-editor-disabled' : ''}`}
        title={disabled ? '正在保存…' : undefined}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleOpenChange(!open);
          }
        }}
      >
        {pills.length === 0 ? <span className="muted">—</span> : null}
        {visible.map((pill) => (
          <Tag
            key={`${pill.inherited ? 'inherited' : 'tag'}-${pill.key}`}
            color={pill.inherited ? undefined : 'blue'}
            bordered={pill.inherited}
            title={pill.inherited ? `继承自 server：${pill.key}` : pill.key}
          >
            {tagLabel(dictionary, pill.key)}
          </Tag>
        ))}
        {hidden.length === 0 ? null : (
          <span className="tag-editor-more" title={hidden.map((pill) => pill.key).join(', ')}>
            +{hidden.length}
          </span>
        )}
        <EditOutlined className="tag-editor-edit" />
      </span>
    </Popover>
  );
}
