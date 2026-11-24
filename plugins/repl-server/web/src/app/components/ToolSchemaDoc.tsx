/** Read-only tool documentation: metadata, flattened input schema and the raw JSON. */
import { Alert, Collapse, Descriptions, Space, Table, Tag, Typography } from 'antd';

import { schemaDoc, type SchemaField } from '../../lib/schema-doc.ts';
import { formatBytes, formatNumber, formatPercent, formatTimestamp } from '../../lib/format.ts';
import { toolStatsFrom, toolSuccessRate, type ToolStats } from '../../lib/tool-stats.ts';
import { JsonView } from './JsonView.tsx';

export interface ToolSchemaDocTool extends Partial<ToolStats> {
  serverId: string;
  name: string;
  description: string | null;
  descriptionOverride: string | null;
  enabled: boolean;
  concurrency: string;
  discoveredVia?: 'static' | 'search';
  tags: string[];
  category: string | null;
  schema: unknown;
}

const PARAM_COLUMNS = [
  {
    title: '参数名',
    dataIndex: 'path',
    width: 190,
    render: (value: string) => <span className="mono">{value}</span>,
  },
  {
    title: '类型',
    dataIndex: 'type',
    width: 150,
    render: (value: string, field: SchemaField) => (
      <div>
        <span className="mono">{value}</span>
        {field.additionalProperties === null ? null : (
          <div className="muted">
            {field.additionalProperties ? '允许额外键' : '禁止额外键'}
          </div>
        )}
      </div>
    ),
  },
  {
    title: '必填',
    dataIndex: 'required',
    width: 64,
    render: (value: boolean) => (
      <Tag bordered={false} color={value ? 'error' : 'default'}>
        {value ? '是' : '否'}
      </Tag>
    ),
  },
  {
    title: '说明',
    dataIndex: 'description',
    render: (value: string | null) => (value === null || value === '' ? '—' : value),
  },
  {
    title: '默认值',
    dataIndex: 'defaultValue',
    width: 96,
    render: (value: string | null) =>
      value === null ? '—' : <span className="mono">{value}</span>,
  },
  {
    title: '枚举',
    dataIndex: 'enumValues',
    width: 150,
    render: (value: string[] | null) =>
      value === null ? '—' : <span className="mono">{value.join('、')}</span>,
  },
];

export function ToolSchemaDoc({ tool }: { tool: ToolSchemaDocTool }): React.ReactElement {
  const doc = schemaDoc(tool.schema);
  const description = tool.descriptionOverride ?? tool.description;
  const stats = toolStatsFrom(tool);
  const successRate = toolSuccessRate(stats);
  const called = stats.callCount > 0;
  const schemaIsRecord =
    typeof tool.schema === 'object' && tool.schema !== null && !Array.isArray(tool.schema);

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <div>
        <Typography.Text type="secondary">生效描述</Typography.Text>
        <Typography.Paragraph
          style={{ marginTop: 4, marginBottom: 0, whiteSpace: 'pre-wrap' }}
        >
          {description === null || description.trim() === '' ? '—' : description}
        </Typography.Paragraph>
      </div>

      <Descriptions size="small" column={2}>
        <Descriptions.Item label="来源">
          {tool.discoveredVia === 'search' ? 'search（懒加载）' : 'static'}
        </Descriptions.Item>
        <Descriptions.Item label="分类">
          {tool.category === null || tool.category === '' ? '—' : tool.category}
        </Descriptions.Item>
        <Descriptions.Item label="标签">
          {tool.tags.length === 0 ? (
            '—'
          ) : (
            <Space size={4} wrap>
              {tool.tags.map((tag) => (
                <Tag key={tag} bordered={false}>
                  {tag}
                </Tag>
              ))}
            </Space>
          )}
        </Descriptions.Item>
        <Descriptions.Item label="启用">
          <Tag bordered={false} color={tool.enabled ? 'success' : 'default'}>
            {tool.enabled ? '已启用' : '已停用'}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="并发">{tool.concurrency}</Descriptions.Item>
      </Descriptions>

      <Descriptions size="small" column={2} title="使用统计">
        <Descriptions.Item label="使用次数">{formatNumber(stats.callCount)}</Descriptions.Item>
        <Descriptions.Item label="成功次数">
          {called ? formatNumber(stats.successCount) : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="失败次数">
          {called ? formatNumber(Math.max(0, stats.callCount - stats.successCount)) : '—'}
        </Descriptions.Item>
        <Descriptions.Item label="成功率">
          {successRate === null ? '—' : formatPercent(successRate)}
        </Descriptions.Item>
        <Descriptions.Item label="最近使用">
          <span className="mono">{formatTimestamp(stats.lastCalledAt)}</span>
        </Descriptions.Item>
      </Descriptions>

      <Descriptions size="small" column={4} title="模型字节">
        <Descriptions.Item label="definition">
          {formatBytes(stats.modelBytes.definition)}
        </Descriptions.Item>
        <Descriptions.Item label="searchItem">
          {formatBytes(stats.modelBytes.searchItem)}
        </Descriptions.Item>
        <Descriptions.Item label="schema">
          {formatBytes(stats.modelBytes.schema)}
        </Descriptions.Item>
        <Descriptions.Item label="description">
          {formatBytes(stats.modelBytes.description)}
        </Descriptions.Item>
      </Descriptions>

      <div>
        <Typography.Title level={5} style={{ marginBottom: 8 }}>
          参数
        </Typography.Title>
        {doc.fields.length === 0 ? (
          <Alert
            type="info"
            showIcon
            message={
              schemaIsRecord
                ? 'input schema 中没有可展开的 properties；原始 JSON 见下方。'
                : 'input schema 不可用或不是对象；原始 JSON 见下方。'
            }
          />
        ) : (
          <>
            <Table<SchemaField>
              size="small"
              rowKey="path"
              dataSource={doc.fields}
              columns={PARAM_COLUMNS}
              pagination={false}
              scroll={{ x: 760 }}
              locale={{ emptyText: '没有参数' }}
            />
            {doc.truncated ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 8 }}
                message="参数过多或嵌套过深，只展示前 100 行 / 前 4 层。"
              />
            ) : null}
          </>
        )}
      </div>

      <Collapse
        size="small"
        items={[
          {
            key: 'raw',
            label: '原始 input schema',
            children:
              tool.schema === undefined ? (
                <Typography.Text type="secondary">（该工具没有返回 schema）</Typography.Text>
              ) : (
                <JsonView value={tool.schema} maxHeight={320} />
              ),
          },
        ]}
      />
    </Space>
  );
}
