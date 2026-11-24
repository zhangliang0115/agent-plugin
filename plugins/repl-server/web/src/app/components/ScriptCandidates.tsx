/** P3 script-candidate review queue: list, scan, accept and reject (10 §9.2, §10). */
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { ApiError } from '../../lib/api.ts';
import { formatNumber, formatPercent, formatTimestamp } from '../../lib/format.ts';
import {
  candidateAcceptFrom,
  candidatesFrom,
  nextCursorFrom,
  scanResultFrom,
  successRateFraction,
  type CandidateAcceptResult,
  type CandidateScanResult,
  type ScriptCandidate,
} from '../../lib/script-api.ts';
import { candidateAcceptBody, type CandidateAcceptFields } from '../../lib/script-edit.ts';

const { Text } = Typography;

const CANDIDATE_LIMIT = 50;

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待审核' },
  { value: 'accepted', label: '已接受' },
  { value: 'rejected', label: '已拒绝' },
];

const DEFAULT_SCHEMA = '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}';

const EMPTY_FIELDS: CandidateAcceptFields = {
  name: '',
  description: '',
  tags: '',
  code: '',
  inputSchema: DEFAULT_SCHEMA,
  exampleArgs: '',
};

export function ScriptCandidates({
  onAccepted,
}: {
  /** Reloads the script list after a candidate becomes a draft. */
  onAccepted: () => void | Promise<void>;
}): React.ReactElement {
  const api = useApi();
  const { message, modal } = AntApp.useApp();

  const [status, setStatus] = useState('pending');
  const [candidates, setCandidates] = useState<ScriptCandidate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const [scanRunning, setScanRunning] = useState(false);
  const [scanResult, setScanResult] = useState<CandidateScanResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);

  const [accepting, setAccepting] = useState<ScriptCandidate | null>(null);
  const [fields, setFields] = useState<CandidateAcceptFields>(EMPTY_FIELDS);
  const [saving, setSaving] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState<CandidateAcceptResult | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const load = useCallback(
    async (nextCursor: string | null, append = false): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const params: Record<string, string | number> = { limit: CANDIDATE_LIMIT };
        if (status !== '') params['status'] = status;
        if (nextCursor !== null) params['cursor'] = nextCursor;
        const response = await api.get<unknown>('/script-candidates', { query: params });
        const items = candidatesFrom(response);
        setCandidates((previous) => (append ? [...previous, ...items] : items));
        setCursor(nextCursorFrom(response));
        setMissing(false);
      } catch (failure) {
        if (!append) setCandidates([]);
        if (failure instanceof ApiError && failure.status === 404) {
          setMissing(true);
        } else {
          setError(failureText(failure));
        }
      } finally {
        setLoading(false);
      }
    },
    [api, status],
  );

  useEffect(() => {
    void load(null);
  }, [load]);

  async function scan(): Promise<void> {
    setScanRunning(true);
    setScanError(null);
    try {
      const response = await api.post<unknown>('/script-candidates/scan', {});
      const result = scanResultFrom(response);
      setScanResult(result);
      message.success(
        `扫描完成：扫到 ${count(result.scanned)}，新增 ${count(result.created)}，更新 ${count(result.updated)}`,
      );
      await load(null);
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 404) {
        setMissing(true);
      } else {
        setScanError(failureText(failure));
      }
    } finally {
      setScanRunning(false);
    }
  }

  function openAccept(candidate: ScriptCandidate): void {
    setAccepting(candidate);
    setAcceptError(null);
    setAccepted(null);
    setFields({
      name: candidate.suggestedName ?? '',
      description: candidate.suggestedDescription ?? '',
      tags: candidate.suggestedTags.join(', '),
      code: candidate.suggestedCode ?? candidate.code ?? '',
      inputSchema: schemaText(candidate.suggestedInputSchema),
      exampleArgs: '',
    });
  }

  async function submitAccept(): Promise<void> {
    if (accepting === null) return;
    const outcome = candidateAcceptBody(fields);
    if (!outcome.ok) {
      setAcceptError(outcome.error);
      return;
    }
    setSaving(true);
    setAcceptError(null);
    try {
      const response = await api.post<unknown>(
        `/script-candidates/${encodeURIComponent(accepting.id)}/accept`,
        outcome.body,
      );
      setAccepted(candidateAcceptFrom(response));
      setAccepting(null);
      message.success('候选已接受，已生成 draft 版本');
      await load(null);
      await onAccepted();
    } catch (failure) {
      setAcceptError(failureText(failure));
    } finally {
      setSaving(false);
    }
  }

  function reject(candidate: ScriptCandidate): void {
    modal.confirm({
      title: `拒绝候选 ${candidate.id}？`,
      content: '拒绝后该候选不再出现在待审核列表；原始执行归档不受影响。',
      okText: '拒绝',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: async () => {
        setRejectingId(candidate.id);
        try {
          await api.post(`/script-candidates/${encodeURIComponent(candidate.id)}/reject`, {});
          message.success('已拒绝候选');
          await load(null);
        } catch (failure) {
          message.error(`拒绝失败：${failureText(failure)}`);
        } finally {
          setRejectingId(null);
        }
      },
    });
  }

  const columns: TableProps<ScriptCandidate>['columns'] = [
    {
      title: '候选 ID',
      key: 'id',
      width: 200,
      ellipsis: true,
      render: (_value, candidate) => <span className="mono">{candidate.id}</span>,
    },
    {
      title: '状态',
      key: 'status',
      width: 90,
      render: (_value, candidate) => <CandidateStatusTag status={candidate.status} />,
    },
    {
      title: '评分',
      key: 'score',
      width: 80,
      align: 'right',
      render: (_value, candidate) => (
        <span className="mono">{formatPercent(successRateFraction(candidate.score))}</span>
      ),
    },
    {
      title: '运行次数',
      key: 'runCount',
      width: 90,
      align: 'right',
      render: (_value, candidate) => (
        <span className="mono">
          {formatNumber(candidate.runCount ?? candidate.sourceRunIds.length)}
        </span>
      ),
    },
    {
      title: 'codeSha256',
      key: 'codeSha256',
      width: 130,
      render: (_value, candidate) =>
        candidate.codeSha256 === null ? (
          <span className="muted">—</span>
        ) : (
          <span className="mono" title={candidate.codeSha256}>
            {candidate.codeSha256.slice(0, 12)}…
          </span>
        ),
    },
    {
      title: '建议名称',
      key: 'suggestedName',
      width: 160,
      ellipsis: true,
      render: (_value, candidate) => candidate.suggestedName ?? <span className="muted">—</span>,
    },
    {
      title: '建议描述',
      key: 'suggestedDescription',
      ellipsis: true,
      render: (_value, candidate) => (
        <Text type="secondary">{candidate.suggestedDescription ?? '—'}</Text>
      ),
    },
    {
      title: '标签',
      key: 'suggestedTags',
      width: 170,
      render: (_value, candidate) =>
        candidate.suggestedTags.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <Space size={4} wrap>
            {candidate.suggestedTags.map((tag) => (
              <Tag key={tag}>{tag}</Tag>
            ))}
          </Space>
        ),
    },
    {
      title: '最近出现',
      key: 'lastSeenAt',
      width: 170,
      render: (_value, candidate) => (
        <span className="mono">{formatTimestamp(candidate.lastSeenAt)}</span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_value, candidate) => {
        const actionable = candidate.status === null || candidate.status === 'pending';
        return (
          <Space size={6}>
            <Button size="small" disabled={!actionable} onClick={() => openAccept(candidate)}>
              接受
            </Button>
            <Button
              size="small"
              danger
              disabled={!actionable}
              loading={rejectingId === candidate.id}
              onClick={() => reject(candidate)}
            >
              拒绝
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <Card size="small" title="候选">
        <Space wrap size={[12, 10]}>
          <Select
            value={status}
            style={{ width: 150 }}
            options={STATUS_OPTIONS}
            onChange={setStatus}
          />
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load(null)}>
            刷新
          </Button>
          <Button type="primary" loading={scanRunning} onClick={() => void scan()}>
            扫描
          </Button>
          <Text type="secondary" style={{ fontSize: 11.5 }}>
            扫描成功的 run_script 执行并聚类成候选；接受后才生成 draft，测试通过才激活。
          </Text>
        </Space>
        {scanResult === null ? null : (
          <Alert
            style={{ marginTop: 10 }}
            type="success"
            showIcon
            message="上次扫描"
            description={`扫描 ${count(scanResult.scanned)} 次执行，新建 ${count(scanResult.created)} 个候选，更新 ${count(scanResult.updated)} 个候选。`}
          />
        )}
        {scanError === null ? null : (
          <Alert
            style={{ marginTop: 10 }}
            type="error"
            showIcon
            message="扫描失败"
            description={scanError}
          />
        )}
        {missing ? (
          <Alert
            style={{ marginTop: 10 }}
            type="info"
            showIcon
            message="候选接口尚未实现"
            description="GET /admin/api/script-candidates 返回 404；页面不使用本地假数据。"
          />
        ) : null}
        {error === null ? null : (
          <Alert style={{ marginTop: 10 }} type="error" showIcon message="候选列表读取失败" description={error} />
        )}
        {accepted === null ? null : (
          <Alert
            style={{ marginTop: 10 }}
            type="success"
            showIcon
            closable
            message="已接受候选"
            description={`生成的脚本：scriptId=${accepted.scriptId ?? '—'}，version=${
              accepted.version === null ? '—' : `v${accepted.version}`
            }，状态=${accepted.status ?? 'draft'}${
              accepted.warnings.length === 0
                ? ''
                : `；疑似密钥（仅提示）：${accepted.warnings
                    .map((warning) => `${warning.field ?? 'value'}·${warning.kind} ×${warning.count ?? 1}`)
                    .join('；')}`
            }`}
            onClose={() => setAccepted(null)}
          />
        )}
      </Card>

      <Table<ScriptCandidate>
        size="small"
        rowKey="id"
        loading={loading}
        dataSource={candidates}
        columns={columns}
        pagination={false}
        scroll={{ x: 1_300 }}
        locale={{
          emptyText: (
            <Empty
              description={
                missing
                  ? '候选接口尚未实现。'
                  : error !== null
                    ? '候选列表不可用。'
                    : status === 'pending'
                      ? '没有待审核的候选。点“扫描”从成功执行里生成。'
                      : '没有匹配的候选。'
              }
            />
          ),
        }}
      />
      {cursor === null ? null : (
        <Button loading={loading} onClick={() => void load(cursor, true)}>
          加载更多
        </Button>
      )}

      <Modal
        title={accepting === null ? '接受候选' : `接受候选 ${accepting.id}`}
        open={accepting !== null}
        onCancel={() => setAccepting(null)}
        onOk={() => void submitAccept()}
        confirmLoading={saving}
        okText="接受并生成 draft"
        width={860}
        destroyOnHidden
      >
        {accepting === null ? null : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Text type="secondary">
              接受后生成 draft 版本；测试成功后才能激活。评分{' '}
              {formatPercent(successRateFraction(accepting.score))}；来源执行{' '}
              {formatNumber(accepting.sourceRunIds.length)} 次。
            </Text>
            {acceptError === null ? null : (
              <Alert type="error" showIcon message="提交失败" description={acceptError} />
            )}
            <div>
              <Text type="secondary">name</Text>
              <Input
                value={fields.name}
                onChange={(event) => setFields({ ...fields, name: event.target.value })}
                placeholder="全局唯一，重名会返回 SCRIPT_NAME_CONFLICT"
              />
            </div>
            <div>
              <Text type="secondary">description</Text>
              <Input.TextArea
                value={fields.description}
                onChange={(event) => setFields({ ...fields, description: event.target.value })}
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
            </div>
            <div>
              <Text type="secondary">tags（逗号分隔）</Text>
              <Input
                value={fields.tags}
                onChange={(event) => setFields({ ...fields, tags: event.target.value })}
                placeholder="server 名或业务标签"
              />
            </div>
            <div>
              <Text type="secondary">code</Text>
              <Input.TextArea
                value={fields.code}
                onChange={(event) => setFields({ ...fields, code: event.target.value })}
                autoSize={{ minRows: 10, maxRows: 20 }}
                className="mono"
              />
            </div>
            <div>
              <Text type="secondary">inputSchema（JSON）</Text>
              <Input.TextArea
                value={fields.inputSchema}
                onChange={(event) => setFields({ ...fields, inputSchema: event.target.value })}
                autoSize={{ minRows: 6, maxRows: 14 }}
                className="mono"
              />
            </div>
            <div>
              <Text type="secondary">exampleArgs（JSON，可留空）</Text>
              <Input.TextArea
                value={fields.exampleArgs}
                onChange={(event) => setFields({ ...fields, exampleArgs: event.target.value })}
                placeholder='{"x":1}'
                autoSize={{ minRows: 4, maxRows: 10 }}
                className="mono"
              />
            </div>
          </Space>
        )}
      </Modal>
    </Space>
  );
}

function CandidateStatusTag({ status }: { status: string | null }): React.ReactElement {
  if (status === null) return <span className="muted">—</span>;
  const labels: Record<string, { color: string; label: string }> = {
    pending: { color: 'gold', label: '待审核' },
    accepted: { color: 'green', label: '已接受' },
    rejected: { color: 'default', label: '已拒绝' },
  };
  const entry = labels[status];
  return (
    <Tag color={entry?.color} bordered={false}>
      {entry?.label ?? status}
    </Tag>
  );
}

function schemaText(value: unknown): string {
  if (value === undefined || value === null) return DEFAULT_SCHEMA;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return DEFAULT_SCHEMA;
  }
}

function count(value: number | null): string {
  return value === null ? '—' : formatNumber(value);
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
