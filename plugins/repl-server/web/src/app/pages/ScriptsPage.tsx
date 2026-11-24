/** Saved-script library: global list, versions, code/schema and run history (10 §9.2–9.3). */
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Drawer,
  Empty,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { TableProps } from 'antd';
import { EditOutlined, ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { PageHeader, StateTag } from '../components/common.tsx';
import { JsonView } from '../components/JsonView.tsx';
import { ScriptCandidates } from '../components/ScriptCandidates.tsx';
import {
  RequestDetailDrawer,
  loadRequestDetailEvents,
  type DetailAuditEvent,
  type RequestFramePair,
} from '../components/RequestDetailDrawer.tsx';
import { ApiError, type FramesResponse } from '../../lib/api.ts';
import {
  formatDuration,
  formatNumber,
  formatPercent,
  formatTimestamp,
} from '../../lib/format.ts';
import { argsSummary } from '../../lib/script-info.ts';
import { testArgsFrom, versionEditBody } from '../../lib/script-edit.ts';
import {
  createdVersion,
  diffFrom,
  failedRunCount,
  runsFrom,
  scriptDetailFrom,
  scriptsFrom,
  secretWarningsFrom,
  successRateFraction,
  testResultFrom,
  versionDetailFrom,
  versionsFrom,
  type ScriptDetail,
  type ScriptRun,
  type ScriptSummary,
  type ScriptTestResult,
  type ScriptVersionDetail,
  type ScriptVersionDiff,
  type ScriptVersionSummary,
  type SecretWarningView,
} from '../../lib/script-api.ts';

const { Text } = Typography;

/** One page is enough for P1; the API also returns `nextCursor` for a later revision. */
const LIST_LIMIT = 200;
const RUN_LIMIT = 100;

const STATUS_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'active', label: '启用' },
  { value: 'draft', label: '草稿' },
  { value: 'disabled', label: '已停用' },
  { value: 'archived', label: '已归档' },
];

export function ScriptsPage(): React.ReactElement {
  const api = useApi();
  const { message } = AntApp.useApp();

  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [scripts, setScripts] = useState<ScriptSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string | number> = { limit: LIST_LIMIT };
      if (query.trim() !== '') params['q'] = query.trim();
      if (status !== '') params['status'] = status;
      const response = await api.get<unknown>('/scripts', { query: params });
      setScripts(scriptsFrom(response));
      setMissing(false);
    } catch (failure) {
      setScripts([]);
      if (failure instanceof ApiError && failure.status === 404) {
        setMissing(true);
      } else {
        setError(failureText(failure));
      }
    } finally {
      setLoading(false);
    }
  }, [api, query, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ScriptDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [versions, setVersions] = useState<ScriptVersionSummary[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [versionDetail, setVersionDetail] = useState<ScriptVersionDetail | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState<string | null>(null);

  const [runs, setRuns] = useState<ScriptRun[]>([]);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [historyPair, setHistoryPair] = useState<RequestFramePair | null>(null);
  const [historyEvents, setHistoryEvents] = useState<DetailAuditEvent[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const [editOpen, setEditOpen] = useState(false);
  const [editCode, setEditCode] = useState('');
  const [editSchema, setEditSchema] = useState('');
  const [editExampleArgs, setEditExampleArgs] = useState('');
  const [editRunId, setEditRunId] = useState('');
  const [saving, setSaving] = useState(false);

  const [diffBase, setDiffBase] = useState<number | null>(null);
  const [diffTarget, setDiffTarget] = useState<number | null>(null);
  const [diff, setDiff] = useState<ScriptVersionDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffMissing, setDiffMissing] = useState(false);
  const [diffTried, setDiffTried] = useState(false);

  const [testOpen, setTestOpen] = useState(false);
  const [testVersion, setTestVersion] = useState<number | null>(null);
  const [testArgs, setTestArgs] = useState('{}');
  const [testActivate, setTestActivate] = useState(false);
  const [testRunning, setTestRunning] = useState(false);
  const [testResult, setTestResult] = useState<ScriptTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  /** Invalidates a slower detail/run response after the user moved on. */
  const detailTicketRef = useRef(0);
  const historyTicketRef = useRef(0);
  const diffTicketRef = useRef(0);

  const loadDetail = useCallback(
    async (scriptId: string, preferVersion: number | null, ticket: number): Promise<void> => {
      setDetailLoading(true);
      setDetailError(null);
      setVersionError(null);
      setVersionDetail(null);
      const [scriptResult, versionsResult] = await Promise.allSettled([
        api.get<unknown>(`/scripts/${encodeURIComponent(scriptId)}`),
        api.get<unknown>(`/scripts/${encodeURIComponent(scriptId)}/versions`),
      ]);
      if (ticket !== detailTicketRef.current) return;
      const found = scriptResult.status === 'fulfilled' ? scriptDetailFrom(scriptResult.value) : null;
      setDetail(found);
      if (scriptResult.status === 'rejected') {
        setDetailError(failureText(scriptResult.reason));
      } else if (found === null) {
        setDetailError('详情响应缺少 scriptId');
      }
      const list = versionsResult.status === 'fulfilled' ? versionsFrom(versionsResult.value) : [];
      setVersions(list);
      if (versionsResult.status === 'rejected' && found !== null) {
        setDetailError(failureText(versionsResult.reason));
      }
      setSelectedVersion(
        preferVersion ?? found?.activeVersion ?? list[list.length - 1]?.version ?? null,
      );
      setDetailLoading(false);
    },
    [api],
  );

  useEffect(() => {
    if (selectedId === null || selectedVersion === null) {
      setVersionDetail(null);
      return undefined;
    }
    let alive = true;
    setVersionLoading(true);
    setVersionError(null);
    void api
      .get<unknown>(
        `/scripts/${encodeURIComponent(selectedId)}/versions/${String(selectedVersion)}`,
      )
      .then((payload) => {
        if (alive) setVersionDetail(versionDetailFrom(payload));
      })
      .catch((failure: unknown) => {
        if (!alive) return;
        setVersionDetail(null);
        setVersionError(failureText(failure));
      })
      .finally(() => {
        if (alive) setVersionLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, selectedId, selectedVersion]);

  useEffect(() => {
    // Any in-flight diff belongs to the previous version pair.
    diffTicketRef.current += 1;
    setDiffLoading(false);
    if (versions.length < 2) {
      setDiffBase(null);
      setDiffTarget(null);
      return;
    }
    const target = selectedVersion ?? versions[versions.length - 1]?.version ?? null;
    if (target === null) return;
    const index = versions.findIndex((entry) => entry.version === target);
    if (index > 0) {
      setDiffBase(versions[index - 1]?.version ?? null);
      setDiffTarget(target);
    } else {
      // The first version has no predecessor; compare it forward instead of
      // sending baseVersion > version to the endpoint.
      setDiffBase(target);
      setDiffTarget(versions[1]?.version ?? null);
    }
    setDiff(null);
    setDiffMissing(false);
    setDiffError(null);
    setDiffTried(false);
  }, [versions, selectedVersion]);

  async function loadDiff(): Promise<void> {
    if (selectedId === null || diffBase === null || diffTarget === null) return;
    const ticket = ++diffTicketRef.current;
    setDiffLoading(true);
    setDiffError(null);
    setDiffMissing(false);
    setDiffTried(true);
    setDiff(null);
    try {
      const response = await api.get<unknown>(
        `/scripts/${encodeURIComponent(selectedId)}/versions/${String(diffTarget)}/diff`,
        { query: { baseVersion: diffBase } },
      );
      if (ticket !== diffTicketRef.current) return;
      setDiff(diffFrom(response));
    } catch (failure) {
      if (ticket !== diffTicketRef.current) return;
      if (failure instanceof ApiError && failure.status === 404) {
        setDiffMissing(true);
      } else {
        setDiffError(failureText(failure));
      }
    } finally {
      if (ticket === diffTicketRef.current) setDiffLoading(false);
    }
  }

  useEffect(() => {
    if (selectedId === null) {
      setRuns([]);
      return undefined;
    }
    let alive = true;
    setRunsLoading(true);
    setRunsError(null);
    void api
      .get<unknown>(`/scripts/${encodeURIComponent(selectedId)}/runs`, {
        query: { limit: RUN_LIMIT },
      })
      .then((payload) => {
        if (alive) setRuns(runsFrom(payload));
      })
      .catch((failure: unknown) => {
        if (!alive) return;
        setRuns([]);
        setRunsError(failureText(failure));
      })
      .finally(() => {
        if (alive) setRunsLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [api, selectedId]);

  function openScript(scriptId: string): void {
    const ticket = ++detailTicketRef.current;
    diffTicketRef.current += 1;
    setSelectedId(scriptId);
    setDetail(null);
    setVersions([]);
    setSelectedVersion(null);
    setVersionDetail(null);
    setHistoryPair(null);
    setHistoryEvents(null);
    setHistoryError(null);
    setDiff(null);
    setDiffError(null);
    setDiffMissing(false);
    setDiffTried(false);
    setTestOpen(false);
    setTestResult(null);
    setTestError(null);
    void loadDetail(scriptId, null, ticket);
  }

  function closeScript(): void {
    detailTicketRef.current += 1;
    historyTicketRef.current += 1;
    diffTicketRef.current += 1;
    setSelectedId(null);
    setDetail(null);
    setVersions([]);
    setSelectedVersion(null);
    setVersionDetail(null);
    setDetailError(null);
    setVersionError(null);
    setDetailLoading(false);
    setVersionLoading(false);
    setRuns([]);
    setRunsError(null);
    setRunsLoading(false);
    setHistoryPair(null);
    setHistoryEvents(null);
    setHistoryError(null);
    setHistoryLoading(false);
    setDiff(null);
    setDiffError(null);
    setDiffMissing(false);
    setDiffTried(false);
    setDiffLoading(false);
    setTestOpen(false);
    setTestResult(null);
    setTestError(null);
    setTestRunning(false);
  }

  async function activateVersion(version: number): Promise<void> {
    if (selectedId === null) return;
    try {
      await api.post<unknown>(
        `/scripts/${encodeURIComponent(selectedId)}/versions/${String(version)}/activate`,
      );
      message.success(`已激活 v${version}`);
      await loadDetail(selectedId, version, ++detailTicketRef.current);
      await load();
    } catch (failure) {
      message.error(`激活失败：${failureText(failure)}`);
    }
  }

  async function changeStatus(next: 'disabled' | 'archived'): Promise<void> {
    if (selectedId === null) return;
    try {
      await api.patch<unknown>(`/scripts/${encodeURIComponent(selectedId)}`, { status: next });
      message.success(next === 'disabled' ? '脚本已禁用' : '脚本已归档');
      await loadDetail(selectedId, selectedVersion, ++detailTicketRef.current);
      await load();
    } catch (failure) {
      message.error(`${next === 'disabled' ? '禁用' : '归档'}失败：${failureText(failure)}`);
    }
  }

  /** Opens the shared request drawer for one run via its `requestId` / `execId`. */
  async function openRun(run: ScriptRun): Promise<void> {
    const ticket = ++historyTicketRef.current;
    setHistoryError(null);
    setHistoryEvents(null);
    setHistoryPair(null);
    const created = run.createdAt === null ? Number.NaN : Date.parse(run.createdAt);
    const window =
      Number.isFinite(created)
        ? {
            from: new Date(created - 2_000).toISOString(),
            to: new Date(created + 2_000).toISOString(),
          }
        : {};
    setHistoryLoading(true);
    try {
      const response = await api.get<FramesResponse<RequestFramePair>>('/logs/frames', {
        query: { detail: 'full', limit: 200, ...window },
      });
      if (ticket !== historyTicketRef.current) return;
      const pair = (response.frames ?? []).find((candidate) => sameRequest(candidate, run));
      if (pair === undefined) {
        setHistoryError('这条执行对应的请求记录已过期或已清理，无法打开请求详情。');
        return;
      }
      setHistoryPair(pair);
      const loaded = await loadRequestDetailEvents(api, pair);
      if (ticket !== historyTicketRef.current) return;
      setHistoryEvents(loaded.events);
    } catch (failure) {
      if (ticket !== historyTicketRef.current) return;
      setHistoryError(failureText(failure));
    } finally {
      if (ticket === historyTicketRef.current) setHistoryLoading(false);
    }
  }

  function openEdit(): void {
    if (versionDetail === null) return;
    setEditCode(versionDetail.code ?? '');
    setEditSchema(
      jsonText(
        versionDetail.inputSchema,
        '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}',
      ),
    );
    setEditExampleArgs(jsonText(versionDetail.exampleArgs, ''));
    setEditRunId('');
    setEditOpen(true);
  }

  async function submitEdit(): Promise<void> {
    if (selectedId === null || versionDetail === null) return;
    const outcome = versionEditBody({
      mode: versionDetail.mode ?? detail?.mode ?? null,
      code: editCode,
      inputSchema: editSchema,
      exampleArgs: editExampleArgs,
      runId: editRunId,
    });
    if (!outcome.ok) {
      message.error(outcome.error);
      return;
    }
    setSaving(true);
    try {
      const response = await api.post<unknown>(
        `/scripts/${encodeURIComponent(selectedId)}/versions`,
        outcome.body,
      );
      const warnings = secretWarningsFrom(response);
      if (warnings.length > 0) {
        message.warning(`新 draft 疑似包含密钥：${secretWarningText(warnings)}。仅提示，不阻断保存。`);
      }
      message.success('已生成 draft 版本');
      setEditOpen(false);
      await loadDetail(selectedId, createdVersion(response), ++detailTicketRef.current);
      await load();
    } catch (failure) {
      message.error(`生成 draft 失败：${failureText(failure)}`);
    } finally {
      setSaving(false);
    }
  }

  function openTest(): void {
    if (versionDetail === null || selectedVersion === null) return;
    setTestVersion(selectedVersion);
    setTestArgs(versionDetail.mode === 'exact' ? '' : jsonText(versionDetail.exampleArgs, '{}'));
    setTestActivate(false);
    setTestResult(null);
    setTestError(null);
    setTestOpen(true);
  }

  async function submitTest(): Promise<void> {
    if (selectedId === null || testVersion === null) return;
    const args = testArgsFrom(testArgs);
    if (!args.ok) {
      setTestError(args.error);
      return;
    }
    setTestRunning(true);
    setTestError(null);
    setTestResult(null);
    try {
      const response = await api.post<unknown>(
        `/scripts/${encodeURIComponent(selectedId)}/test`,
        {
          version: testVersion,
          ...(args.body === undefined ? {} : { args: args.body }),
          activateOnSuccess: testActivate,
        },
      );
      const result = testResultFrom(response);
      setTestResult(result);
      if (result === null) {
        setTestError('测试接口返回无法识别');
        return;
      }
      if (result.ok === true) {
        message.success(
          result.activated === true ? '测试成功，版本已激活' : '测试成功',
        );
        await loadDetail(selectedId, testVersion, ++detailTicketRef.current);
      } else if (result.ok === false) {
        message.error('测试失败，版本保持 draft');
      }
    } catch (failure) {
      setTestError(failureText(failure));
    } finally {
      setTestRunning(false);
    }
  }

  const columns: TableProps<ScriptSummary>['columns'] = [
    {
      title: 'scriptId',
      key: 'scriptId',
      width: 190,
      render: (_value, script) => <span className="mono">{script.scriptId}</span>,
    },
    {
      title: '名称',
      key: 'name',
      width: 170,
      ellipsis: true,
      render: (_value, script) => script.name ?? '—',
    },
    {
      title: '描述',
      key: 'description',
      ellipsis: true,
      render: (_value, script) => (
        <Text type="secondary">{script.description ?? '—'}</Text>
      ),
    },
    {
      title: '标签',
      key: 'tags',
      width: 180,
      render: (_value, script) => <TagsCell tags={script.tags} />,
    },
    {
      title: '模式',
      key: 'mode',
      width: 135,
      render: (_value, script) => modeLabel(script.mode),
    },
    {
      title: 'active 版本',
      key: 'activeVersion',
      width: 105,
      render: (_value, script) =>
        script.activeVersion === null ? (
          <span className="muted">—</span>
        ) : (
          <span className="mono">v{script.activeVersion}</span>
        ),
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_value, script) =>
        script.status === null ? <span className="muted">—</span> : <StateTag state={script.status} />,
    },
    {
      title: 'owner',
      key: 'createdBy',
      width: 110,
      ellipsis: true,
      render: (_value, script) => script.createdBy ?? <span className="muted">—</span>,
    },
    {
      title: '使用次数',
      key: 'useCount',
      width: 90,
      align: 'right',
      render: (_value, script) => formatNumber(script.useCount),
    },
    {
      title: '执行统计',
      key: 'runStats',
      width: 190,
      render: (_value, script) => {
        const rate =
          script.successRate !== null
            ? successRateFraction(script.successRate)
            : script.runCount !== null && script.successCount !== null && script.runCount > 0
              ? script.successCount / script.runCount
              : null;
        const failed = failedRunCount(script);
        if (script.runCount === null && rate === null) return <span className="muted">—</span>;
        return (
          <span className="mono">
            {script.runCount === null ? null : `${formatNumber(script.runCount)} 次`}
            {rate === null ? null : ` · 成功 ${formatPercent(rate)}`}
            {failed === null ? null : ` · 失败 ${formatNumber(failed)}`}
          </span>
        );
      },
    },
    {
      title: '最近使用',
      key: 'lastUsedAt',
      width: 170,
      render: (_value, script) => (
        <span className="mono">{formatTimestamp(script.lastUsedAt)}</span>
      ),
    },
  ];

  const versionColumns: TableProps<ScriptVersionSummary>['columns'] = [
    {
      title: '版本',
      key: 'version',
      width: 80,
      render: (_value, version) => <span className="mono">v{version.version}</span>,
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_value, version) =>
        version.status === null ? <span className="muted">—</span> : <StateTag state={version.status} />,
    },
    {
      title: '模式',
      key: 'mode',
      width: 130,
      render: (_value, version) => modeLabel(version.mode),
    },
    {
      title: '来源执行',
      key: 'sourceRunId',
      width: 200,
      ellipsis: true,
      render: (_value, version) => (
        <span className="mono">{version.sourceRunId ?? '—'}</span>
      ),
    },
    {
      title: '测试',
      key: 'verifiedRunId',
      width: 110,
      render: (_value, version) =>
        version.verifiedRunId === null ? (
          <Tag color="gold" bordered={false}>
            未测试
          </Tag>
        ) : (
          <span title={version.verifiedRunId}>
            <Tag color="green" bordered={false}>
              已验证
            </Tag>
          </span>
        ),
    },
    {
      title: '创建时间',
      key: 'createdAt',
      width: 170,
      render: (_value, version) => (
        <span className="mono">{formatTimestamp(version.createdAt)}</span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_value, version) => {
        if (version.status === 'active') {
          return (
            <Tag color="green" bordered={false}>
              当前
            </Tag>
          );
        }
        const label = version.status === 'superseded' ? '回滚' : '激活';
        const blocked = activationBlockedReason(version);
        if (blocked !== null) {
          return (
            <Tooltip title={blocked}>
              <span>
                <Button size="small" disabled>
                  {label}
                </Button>
              </span>
            </Tooltip>
          );
        }
        return (
          <Button
            size="small"
            onClick={(event) => {
              event.stopPropagation();
              void activateVersion(version.version);
            }}
          >
            {label}
          </Button>
        );
      },
    },
  ];

  const runColumns: TableProps<ScriptRun>['columns'] = [
    {
      title: '时间',
      key: 'createdAt',
      width: 170,
      render: (_value, run) => <span className="mono">{formatTimestamp(run.createdAt)}</span>,
    },
    {
      title: 'runId',
      key: 'runId',
      width: 200,
      ellipsis: true,
      render: (_value, run) => <span className="mono">{run.runId}</span>,
    },
    {
      title: '版本',
      key: 'scriptVersion',
      width: 80,
      render: (_value, run) =>
        run.scriptVersion === null ? <span className="muted">—</span> : `v${run.scriptVersion}`,
    },
    {
      title: '参数',
      key: 'args',
      ellipsis: true,
      render: (_value, run) => {
        const summary = run.argsPreview ?? argsSummary(run.args, 120);
        return summary === null ? (
          <span className="muted">—</span>
        ) : (
          <span className="mono" title={summary}>
            {summary}
          </span>
        );
      },
    },
    {
      title: '结果',
      key: 'ok',
      width: 110,
      render: (_value, run) =>
        run.ok ? (
          <Tag color="green" bordered={false}>
            成功
          </Tag>
        ) : (
          <span title={run.error ?? ''}>
            <Tag color="red" bordered={false}>
              失败
            </Tag>
          </span>
        ),
    },
    {
      title: '耗时',
      key: 'durationMs',
      width: 90,
      align: 'right',
      render: (_value, run) => <span className="mono">{formatDuration(run.durationMs)}</span>,
    },
    {
      title: '用途',
      key: 'purpose',
      width: 90,
      render: (_value, run) => (run.purpose === 'test' ? '测试' : '执行'),
    },
  ];

  const statsCard =
    detail === null ? null : (
      <StatsSummary detail={detail} fallback={scripts.find((entry) => entry.scriptId === detail.scriptId)} />
    );

  const metadata = detail === null ? null : (
    <Card size="small" title="元数据">
      <Descriptions column={2} size="small">
        <Descriptions.Item label="名称">{detail.name ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="scriptId">
          <span className="mono">{detail.scriptId}</span>
        </Descriptions.Item>
        <Descriptions.Item label="状态">
          {detail.status === null ? '—' : <StateTag state={detail.status} />}
        </Descriptions.Item>
        <Descriptions.Item label="模式">
          {modeLabel(detail.mode ?? versions[versions.length - 1]?.mode ?? null)}
        </Descriptions.Item>
        <Descriptions.Item label="active 版本">
          {detail.activeVersion === null ? '—' : `v${detail.activeVersion}`}
        </Descriptions.Item>
        <Descriptions.Item label="使用次数">{formatNumber(detail.useCount)}</Descriptions.Item>
        <Descriptions.Item label="最近使用">{formatTimestamp(detail.lastUsedAt)}</Descriptions.Item>
        <Descriptions.Item label="更新时间">{formatTimestamp(detail.updatedAt)}</Descriptions.Item>
        <Descriptions.Item label="创建人">{detail.createdBy ?? '—'}</Descriptions.Item>
        <Descriptions.Item label="创建时间">{formatTimestamp(detail.createdAt)}</Descriptions.Item>
        <Descriptions.Item label="来源执行" span={2}>
          <span className="mono">{detail.sourceRunId ?? '—'}</span>
        </Descriptions.Item>
        <Descriptions.Item label="描述" span={2}>
          {detail.description ?? '—'}
        </Descriptions.Item>
        <Descriptions.Item label="标签" span={2}>
          <TagsCell tags={detail.tags} />
        </Descriptions.Item>
      </Descriptions>
    </Card>
  );

  const versionPanel = (
    <Card
      size="small"
      title={selectedVersion === null ? '版本内容' : `v${selectedVersion} 内容`}
      extra={
        versionDetail === null ? null : (
          <Space size={6}>
            <Button size="small" onClick={openTest}>
              测试
            </Button>
            <Button size="small" icon={<EditOutlined />} onClick={openEdit}>
              编辑生成 draft
            </Button>
          </Space>
        )
      }
    >
      {versionLoading ? <Spin size="small" /> : null}
      {versionError === null ? null : (
        <Alert type="error" showIcon message="版本读取失败" description={versionError} />
      )}
      {!versionLoading && versionError === null && versionDetail === null ? (
        <Empty description="选择一个版本查看代码与参数 schema。" />
      ) : null}
      {versionDetail === null ? null : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Descriptions column={2} size="small">
            <Descriptions.Item label="状态">
              {versionDetail.status === null ? '—' : <StateTag state={versionDetail.status} />}
            </Descriptions.Item>
            <Descriptions.Item label="模式">{modeLabel(versionDetail.mode)}</Descriptions.Item>
            <Descriptions.Item label="来源执行">
              <span className="mono">{versionDetail.sourceRunId ?? '—'}</span>
            </Descriptions.Item>
            <Descriptions.Item label="验证执行">
              <span className="mono">{versionDetail.verifiedRunId ?? '—'}</span>
            </Descriptions.Item>
            <Descriptions.Item label="codeSha256">
              <span className="mono">{versionDetail.codeSha256 ?? '—'}</span>
            </Descriptions.Item>
            <Descriptions.Item label="代码字节">
              {formatNumber(versionDetail.codeBytes)}
            </Descriptions.Item>
            <Descriptions.Item label="创建时间">
              {formatTimestamp(versionDetail.createdAt)}
            </Descriptions.Item>
            <Descriptions.Item label="激活时间">
              {formatTimestamp(versionDetail.activatedAt)}
            </Descriptions.Item>
            {versionDetail.changelog === null ? null : (
              <Descriptions.Item label="changelog" span={2}>
                {versionDetail.changelog}
              </Descriptions.Item>
            )}
          </Descriptions>
          {versionDetail.warnings.length === 0 ? null : (
            <Alert
              type="warning"
              showIcon
              message="代码或示例参数疑似包含密钥（仅提示，不阻断）"
              description={secretWarningText(versionDetail.warnings)}
            />
          )}
          <div>
            <Text type="secondary">code</Text>
            <pre
              className="mono"
              style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0', maxHeight: 320, overflow: 'auto' }}
            >
              {versionDetail.code ?? '—'}
            </pre>
          </div>
          <div>
            <Text type="secondary">inputSchema</Text>
            <JsonView value={versionDetail.inputSchema ?? {}} maxHeight={220} />
          </div>
          <div>
            <Text type="secondary">exampleArgs</Text>
            {versionDetail.exampleArgs === undefined || versionDetail.exampleArgs === null ? (
              <div className="muted">—</div>
            ) : (
              <JsonView value={versionDetail.exampleArgs} maxHeight={180} />
            )}
          </div>
        </Space>
      )}
    </Card>
  );

  const editMode = versionDetail?.mode ?? detail?.mode ?? null;

  const versionOptions = versions.map((version) => ({
    value: version.version,
    label: `v${version.version}（${version.status ?? '—'}）`,
  }));

  const diffPanel = (
    <Card size="small" title="版本 diff">
      {versions.length < 2 ? (
        <Empty description="至少两个版本才能对比。" />
      ) : (
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Space wrap size={[10, 8]}>
            <Select
              style={{ width: 190 }}
              placeholder="base 版本"
              value={diffBase ?? undefined}
              options={versionOptions}
              onChange={(value: number) => {
                diffTicketRef.current += 1;
                setDiffLoading(false);
                setDiffBase(value);
                setDiff(null);
                setDiffTried(false);
                setDiffMissing(false);
                setDiffError(null);
              }}
            />
            <Text type="secondary">→</Text>
            <Select
              style={{ width: 190 }}
              placeholder="目标版本"
              value={diffTarget ?? undefined}
              options={versionOptions}
              onChange={(value: number) => {
                diffTicketRef.current += 1;
                setDiffLoading(false);
                setDiffTarget(value);
                setDiff(null);
                setDiffTried(false);
                setDiffMissing(false);
                setDiffError(null);
              }}
            />
            <Button
              type="primary"
              loading={diffLoading}
              disabled={diffBase === null || diffTarget === null || diffBase === diffTarget}
              onClick={() => void loadDiff()}
            >
              对比
            </Button>
            {diffBase !== null && diffBase === diffTarget ? (
              <Text type="secondary">选择两个不同版本。</Text>
            ) : null}
          </Space>
          {diffError === null ? null : (
            <Alert type="error" showIcon message="版本 diff 读取失败" description={diffError} />
          )}
          {!diffMissing ? null : (
            <Alert
              type="info"
              showIcon
              message="版本 diff 接口尚未实现"
              description="GET /scripts/:id/versions/:version/diff 返回 404；页面不使用本地生成的 diff。"
            />
          )}
          {!diffTried || diffLoading || diffMissing || diffError !== null ? null : diff === null ? (
            <Alert
              type="info"
              showIcon
              message="没有可渲染的逐行 diff"
              description="接口返回中没有 lines 数组；等 P2 后端实现后再显示。"
            />
          ) : (
            <DiffLines diff={diff} />
          )}
        </Space>
      )}
    </Card>
  );

  const historyPanel = (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Text type="secondary" style={{ fontSize: 11.5 }}>
        执行历史来自 script_runs（保留 30 天）；点一行打开请求记录详情，不另做执行详情视图。
      </Text>
      {runsError === null ? null : (
        <Alert type="warning" showIcon message="执行历史不可用" description={runsError} />
      )}
      {historyError === null || historyPair !== null ? null : (
        <Alert type="warning" showIcon message="无法打开请求详情" description={historyError} />
      )}
      <Table<ScriptRun>
        size="small"
        rowKey="runId"
        loading={runsLoading}
        dataSource={runs}
        columns={runColumns}
        pagination={{ pageSize: 20, showSizeChanger: false }}
        onRow={(run) => ({
          className: 'row-clickable',
          onClick: () => void openRun(run),
        })}
        locale={{
          emptyText: (
            <Empty description={runsError === null ? '这个脚本还没有执行记录。' : '执行历史接口不可用'} />
          ),
        }}
      />
    </Space>
  );

  return (
    <div className="page">
      <PageHeader
        title="脚本库"
        description="全局脚本库：保存过的 run_script 脚本、不可变版本与执行历史。脚本不按 workspace 隔离，name 全局唯一。"
        actions={
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            刷新
          </Button>
        }
      />

      <Tabs
        items={[
          {
            key: 'scripts',
            label: '脚本',
            children: (
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Card size="small" title="筛选">
                  <Space wrap size={[12, 10]}>
                    <Input.Search
                      allowClear
                      placeholder="按名称、描述、标签搜索"
                      style={{ width: 300 }}
                      value={search}
                      onChange={(event) => {
                        setSearch(event.target.value);
                        if (event.target.value === '') setQuery('');
                      }}
                      onSearch={(value) => setQuery(value)}
                    />
                    <Select
                      value={status}
                      style={{ width: 150 }}
                      options={STATUS_OPTIONS}
                      onChange={setStatus}
                    />
                  </Space>
                </Card>

                {missing ? (
                  <Alert
                    type="info"
                    showIcon
                    message="脚本管理接口尚未实现"
                    description="GET /admin/api/scripts 返回 404；页面会在接口上线后自动显示数据，不使用本地 mock。"
                  />
                ) : null}
                {error === null ? null : (
                  <Alert type="error" showIcon message="脚本列表读取失败" description={error} />
                )}

                <Card
                  size="small"
                  title="脚本"
                  extra={<Text type="secondary">{`共 ${formatNumber(scripts.length)} 个`}</Text>}
                >
                  <Table<ScriptSummary>
                    size="small"
                    rowKey="scriptId"
                    loading={loading}
                    dataSource={scripts}
                    columns={columns}
                    pagination={{ pageSize: 20, showSizeChanger: false }}
                    scroll={{ x: 1_500 }}
                    onRow={(script) => ({
                      className: 'row-clickable',
                      onClick: () => openScript(script.scriptId),
                    })}
                    locale={{
                      emptyText: (
                        <Empty
                          description={
                            missing
                              ? '脚本管理接口尚未实现。'
                              : '还没有脚本。先在 run_script 成功后用 save_script 保存一个。'
                          }
                        />
                      ),
                    }}
                  />
                </Card>
              </Space>
            ),
          },
          {
            key: 'candidates',
            label: '候选',
            children: <ScriptCandidates onAccepted={load} />,
          },
        ]}
      />

      <Drawer
        placement="right"
        open={selectedId !== null}
        onClose={closeScript}
        width={1_000}
        title={detail?.name ?? selectedId ?? '脚本详情'}
        extra={
          selectedId === null ? null : (
            <Space>
              <Button
                disabled={detail?.status === 'disabled'}
                onClick={() => void changeStatus('disabled')}
              >
                禁用
              </Button>
              <Button
                disabled={detail?.status === 'archived'}
                onClick={() => void changeStatus('archived')}
              >
                归档
              </Button>
            </Space>
          )
        }
      >
        {detailLoading ? <Spin size="small" /> : null}
        {detailError === null ? null : (
          <Alert type="error" showIcon message="脚本详情读取失败" description={detailError} />
        )}
        {detailLoading || detailError !== null ? null : (
          <Tabs
            items={[
              {
                key: 'overview',
                label: '概览',
                children: (
                  <Space direction="vertical" size={12} style={{ width: '100%' }}>
                    {statsCard}
                    {metadata}
                    <Card size="small" title="版本列表">
                      <Table<ScriptVersionSummary>
                        size="small"
                        rowKey="version"
                        dataSource={versions}
                        columns={versionColumns}
                        pagination={false}
                        scroll={{ x: 940 }}
                        onRow={(version) => ({
                          className:
                            selectedVersion === version.version
                              ? 'row-clickable row-selected'
                              : 'row-clickable',
                          onClick: () => setSelectedVersion(version.version),
                        })}
                        locale={{ emptyText: '这个脚本没有版本记录。' }}
                      />
                    </Card>
                    {versionPanel}
                    {diffPanel}
                  </Space>
                ),
              },
              { key: 'runs', label: '执行历史', children: historyPanel },
            ]}
          />
        )}
      </Drawer>

      <Modal
        title={
          selectedVersion === null
            ? '编辑生成 draft'
            : `基于 v${selectedVersion} 编辑生成 draft`
        }
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => void submitEdit()}
        confirmLoading={saving}
        okText="生成 draft"
        width={860}
        destroyOnHidden
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Text type="secondary">
            提交后新建一个 draft 版本；当前 active 版本不受影响，测试通过后再激活。
          </Text>
          {editMode === 'exact' ? (
            <>
              <Alert
                type="info"
                showIcon
                message="exact 版本从成功执行取代码"
                description="填写一次成功的 run_script 执行 runId；不能也不会提交 code，inputSchema 保持空对象。"
              />
              <div>
                <Text type="secondary">来源 runId</Text>
                <Input
                  value={editRunId}
                  onChange={(event) => setEditRunId(event.target.value)}
                  placeholder="run_script 成功返回的 runId"
                  className="mono"
                />
              </div>
            </>
          ) : editMode === 'parameterized' ? (
            <>
              <div>
                <Text type="secondary">code</Text>
                <Input.TextArea
                  value={editCode}
                  onChange={(event) => setEditCode(event.target.value)}
                  autoSize={{ minRows: 12, maxRows: 24 }}
                  className="mono"
                />
              </div>
              <div>
                <Text type="secondary">inputSchema（JSON）</Text>
                <Input.TextArea
                  value={editSchema}
                  onChange={(event) => setEditSchema(event.target.value)}
                  autoSize={{ minRows: 6, maxRows: 16 }}
                  className="mono"
                />
              </div>
              <div>
                <Text type="secondary">exampleArgs（JSON）</Text>
                <Input.TextArea
                  value={editExampleArgs}
                  onChange={(event) => setEditExampleArgs(event.target.value)}
                  placeholder='可留空；示例 {"x":1}'
                  autoSize={{ minRows: 4, maxRows: 10 }}
                  className="mono"
                />
              </div>
            </>
          ) : (
            <Alert
              type="warning"
              showIcon
              message="无法确定脚本模式"
              description="版本与脚本都没有返回 mode，不能按 exact/parameterized 规则提交。"
            />
          )}
        </Space>
      </Modal>

      <Modal
        title={testVersion === null ? '测试版本' : `测试 v${testVersion}`}
        open={testOpen}
        onCancel={() => setTestOpen(false)}
        onOk={() => void submitTest()}
        confirmLoading={testRunning}
        okText="运行测试"
        width={760}
        destroyOnHidden
      >
        <Space direction="vertical" size={10} style={{ width: '100%' }}>
          <Text type="secondary">
            测试通过后才能激活；测试执行不更新脚本的 use_count。失败保持 draft。
          </Text>
          {versionDetail?.mode === 'exact' ? (
            <Alert
              type="info"
              showIcon
              message="exact 脚本不接受参数"
              description="不发送 args，直接按保存的原代码执行。"
            />
          ) : (
            <div>
              <Text type="secondary">args（JSON，默认 exampleArgs）</Text>
              <Input.TextArea
                value={testArgs}
                onChange={(event) => setTestArgs(event.target.value)}
                autoSize={{ minRows: 6, maxRows: 14 }}
                className="mono"
              />
            </div>
          )}
          <Checkbox
            checked={testActivate}
            onChange={(event) => setTestActivate(event.target.checked)}
          >
            成功后自动激活（activateOnSuccess）
          </Checkbox>
          {testError === null ? null : (
            <Alert type="error" showIcon message="测试失败" description={testError} />
          )}
          {testResult === null ? null : (
            <Card size="small" title="测试结果">
              <Descriptions column={2} size="small">
                <Descriptions.Item label="runId">
                  <span className="mono">{testResult.runId ?? '—'}</span>
                </Descriptions.Item>
                <Descriptions.Item label="结果">
                  {testResult.ok === null ? (
                    '—'
                  ) : testResult.ok ? (
                    <Tag color="green" bordered={false}>
                      成功
                    </Tag>
                  ) : (
                    <Tag color="red" bordered={false}>
                      失败
                    </Tag>
                  )}
                </Descriptions.Item>
                <Descriptions.Item label="耗时">
                  {formatDuration(testResult.durationMs)}
                </Descriptions.Item>
                <Descriptions.Item label="激活">
                  {testResult.activated === null ? '—' : testResult.activated ? '是' : '否'}
                </Descriptions.Item>
              </Descriptions>
              {testResult.error === null ? null : (
                <Alert type="error" showIcon message="执行错误" description={testResult.error} />
              )}
              {testResult.secretWarnings.length === 0 ? null : (
                <Alert
                  style={{ marginTop: 8 }}
                  type="warning"
                  showIcon
                  message="测试参数疑似包含密钥（仅提示，执行未被阻断）"
                  description={secretWarningText(testResult.secretWarnings)}
                />
              )}
              <div style={{ marginTop: 8 }}>
                <Text type="secondary">输出摘要</Text>
                {testResult.output === undefined ? (
                  <div className="muted">—</div>
                ) : (
                  <JsonView value={testResult.output} maxHeight={220} />
                )}
              </div>
            </Card>
          )}
        </Space>
      </Modal>

      <RequestDetailDrawer
        pair={historyPair}
        events={historyEvents}
        loading={historyLoading}
        error={historyError}
        onClose={() => {
          setHistoryPair(null);
          setHistoryEvents(null);
          setHistoryError(null);
        }}
      />
    </div>
  );
}

function TagsCell({ tags }: { tags: readonly string[] }): React.ReactElement {
  if (tags.length === 0) return <span className="muted">—</span>;
  const shown = tags.slice(0, 4);
  return (
    <Space size={4} wrap>
      {shown.map((tag) => (
        <Tag key={tag}>{tag}</Tag>
      ))}
      {tags.length > shown.length ? <Tag>+{tags.length - shown.length}</Tag> : null}
    </Space>
  );
}

function modeLabel(mode: string | null): string {
  if (mode === 'exact') return 'exact（原样）';
  if (mode === 'parameterized') return 'parameterized（参数化）';
  return mode ?? '—';
}

const SEVERITY_LABELS: Readonly<Record<string, string>> = {
  high: '高',
  medium: '中',
  low: '低',
};

/** One line per aggregated finding; no matched text is ever shown. */
function secretWarningText(warnings: readonly SecretWarningView[]): string {
  return warnings
    .map((warning) => {
      const severity =
        warning.severity === null ? '未知' : (SEVERITY_LABELS[warning.severity] ?? warning.severity);
      const field = warning.field === null ? '' : `${warning.field}：`;
      const count = warning.count === null ? '' : ` ×${warning.count}`;
      return `${field}${severity} · ${warning.kind ?? 'secret'}${count}`;
    })
    .join('；');
}

/** Why the version cannot be activated; `null` means allowed. */
function activationBlockedReason(version: ScriptVersionSummary): string | null {
  if (version.status === 'archived') return '已归档版本不能激活';
  if (version.verifiedRunId === null) return '先测试该版本，测试成功后才能激活';
  return null;
}

/** P2 aggregates: detail first, then the list row when an older detail omits them. */
function StatsSummary({
  detail,
  fallback,
}: {
  detail: ScriptDetail;
  fallback: ScriptSummary | undefined;
}): React.ReactElement {
  const runCount = detail.runCount ?? fallback?.runCount ?? null;
  const successCount = detail.successCount ?? fallback?.successCount ?? null;
  const rate =
    successRateFraction(detail.successRate ?? fallback?.successRate ?? null) ??
    (runCount !== null && successCount !== null && runCount > 0 ? successCount / runCount : null);
  return (
    <Card size="small" title="执行统计">
      <Descriptions column={4} size="small">
        <Descriptions.Item label="执行次数">{formatNumber(runCount)}</Descriptions.Item>
        <Descriptions.Item label="成功">{formatNumber(successCount)}</Descriptions.Item>
        <Descriptions.Item label="失败">
          {formatNumber(failedRunCount({ runCount, successCount }))}
        </Descriptions.Item>
        <Descriptions.Item label="成功率">{formatPercent(rate)}</Descriptions.Item>
      </Descriptions>
      <Text type="secondary" style={{ fontSize: 11.5 }}>
        统计来自 script_runs（保留 30 天）；测试执行不计入使用次数。逐次记录在「执行历史」。
      </Text>
    </Card>
  );
}

function jsonText(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  try {
    return JSON.stringify(value, null, 2) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Renders the server's per-line diff; no local diff is computed when it is absent. */
function DiffLines({ diff }: { diff: ScriptVersionDiff }): React.ReactElement {
  if (diff.lines.length === 0) {
    return <Empty description="两个版本没有逐行差异。" />;
  }
  return (
    <div>
      <Text type="secondary" style={{ fontSize: 11.5 }}>
        {`v${diff.fromVersion ?? '—'} → v${diff.toVersion ?? '—'} · +新增 / -删除 / 空格为未变`}
      </Text>
      <pre
        className="mono"
        style={{
          whiteSpace: 'pre-wrap',
          margin: '4px 0 0',
          maxHeight: 360,
          overflow: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 6,
        }}
      >
        {diff.lines.map((line, index) => (
          <div
            key={`${index}-${line.type}`}
            style={{
              padding: '0 8px',
              background:
                line.type === 'add'
                  ? 'rgba(47, 158, 68, 0.16)'
                  : line.type === 'del'
                    ? 'rgba(212, 56, 13, 0.14)'
                    : undefined,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                width: 14,
                color:
                  line.type === 'add' ? '#2f9e44' : line.type === 'del' ? '#d4380d' : 'inherit',
              }}
            >
              {line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}
            </span>
            {line.text}
          </div>
        ))}
      </pre>
    </div>
  );
}

/** One frame pair belongs to a run when its JSON-RPC id and exec session match. */
function sameRequest(pair: RequestFramePair, run: ScriptRun): boolean {
  if (run.requestId === null || pair.id === null) return false;
  if (String(pair.id) !== run.requestId) return false;
  if (run.execId === null) return true;
  return pair.request?.['exec'] === run.execId || pair.response?.['exec'] === run.execId;
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
