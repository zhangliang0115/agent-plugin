/** Editable env/header rows: a literal plain-config value or a secret reference. */
import { AutoComplete, Button, Col, Input, Row, Select, Space } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import {
  emptyRow,
  type EnvHeaderKind,
  type EnvHeaderRow,
} from '../../lib/env-header.ts';

const SOURCE_OPTIONS = [
  { value: 'literal', label: '普通值' },
  { value: 'secret', label: '密钥引用' },
];

const LABELS = {
  env: {
    key: 'env 键名',
    keyPlaceholder: 'GHIDRA_INSTALL_DIR',
    valuePlaceholder: '例如 /Users/me/tools/ghidra',
    secretPlaceholder: '密钥名，例如 GITHUB_TOKEN',
  },
  headers: {
    key: 'header 名',
    keyPlaceholder: 'Authorization',
    valuePlaceholder: '例如 dev',
    secretPlaceholder: '密钥名，例如 GITHUB_TOKEN',
  },
} as const;

/** Existing secret names for the reference picker; failures leave free-text only. */
export function useSecretNames(): string[] {
  const api = useApi();
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let active = true;
    api
      .get<{ secrets?: Array<{ name?: unknown }> }>('/secrets')
      .then((response) => {
        if (!active || !Array.isArray(response.secrets)) return;
        setNames(
          response.secrets
            .map((entry) => (typeof entry.name === 'string' ? entry.name : ''))
            .filter((name) => name !== ''),
        );
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [api]);
  return names;
}

export function EnvHeaderEditor({
  value,
  onChange,
  kind,
  secretNames,
}: {
  value?: readonly EnvHeaderRow[];
  onChange?: (next: EnvHeaderRow[]) => void;
  kind: EnvHeaderKind;
  secretNames: readonly string[];
}): React.ReactElement {
  const rows = value ?? [];
  const labels = LABELS[kind];

  function replace(next: EnvHeaderRow[]): void {
    onChange?.(next);
  }

  function update(index: number, patch: Partial<EnvHeaderRow>): void {
    replace(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  }

  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      {rows.length === 0 ? <span className="muted">未配置。</span> : null}
      {rows.map((row, index) => {
        const source = row.source;
        return (
          <Row key={index} gutter={8} align="middle">
            <Col flex="1 1 260px">
              <Input
                value={row.key}
                aria-label={`${labels.key} ${index + 1}`}
                placeholder={labels.keyPlaceholder}
                onChange={(event) => update(index, { key: event.target.value })}
              />
            </Col>
            <Col flex="0 0 110px">
              <Select
                style={{ width: '100%' }}
                value={source}
                options={SOURCE_OPTIONS}
                aria-label={`值来源 ${index + 1}`}
                onChange={(next) =>
                  update(index, { source: next === 'secret' ? 'secret' : 'literal', value: '' })
                }
              />
            </Col>
            <Col flex="1 1 220px">
              {source === 'secret' ? (
                <AutoComplete
                  style={{ width: '100%' }}
                  value={row.value}
                  options={secretNames.map((name) => ({ value: name }))}
                  aria-label={`密钥名 ${index + 1}`}
                  placeholder={labels.secretPlaceholder}
                  onChange={(next: string) => update(index, { value: next })}
                />
              ) : (
                <Input
                  value={row.value}
                  aria-label={`${labels.key} 值 ${index + 1}`}
                  placeholder={labels.valuePlaceholder}
                  onChange={(event) => update(index, { value: event.target.value })}
                />
              )}
            </Col>
            <Col flex="0 0 32px">
              <Button
                type="text"
                danger
                icon={<DeleteOutlined />}
                aria-label={`删除第 ${index + 1} 行`}
                onClick={() => replace(rows.filter((_row, position) => position !== index))}
              />
            </Col>
          </Row>
        );
      })}
      <Button type="dashed" block icon={<PlusOutlined />} onClick={() => replace([...rows, emptyRow()])}>
        添加一行
      </Button>
    </Space>
  );
}
