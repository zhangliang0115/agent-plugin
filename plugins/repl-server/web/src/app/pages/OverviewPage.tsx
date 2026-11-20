/** Overview page: attention, live KPIs, capacity, onboarding and runtime hints. */
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Popconfirm,
  Progress,
  Row,
  Space,
  Spin,
  Steps,
  Table,
  Tag,
  theme,
  Typography,
} from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useCallback, useEffect, useRef, useState } from 'react';

import { useApi } from '../api.tsx';
import { Mono, PageHeader } from '../components/common.tsx';
import { ApiError } from '../../lib/api.ts';
import {
  formatBytes,
  formatDuration,
  formatNumber,
  formatPercent,
  formatTimestamp,
  type Tone,
} from '../../lib/format.ts';
import { navigate, type ManageTab } from '../router.ts';

const { Text } = Typography;

interface PoolCounts {
  total: number;
  ready: number;
  reconnecting: number;
  failed: number;
}

interface SessionCounts {
  transport: number;
  exec: number;
  inFlightEvals: number;
}

interface ServerSummary {
  total: number;
  enabled: number;
}

interface ResourceSample {
  ts: number;
  selfRssBytes: number;
  childRssBytes: number;
  childCount: number;
  totalRssBytes: number;
  selfCpuPercent: number;
  childCpuPercent: number;
  totalCpuPercent: number;
}

interface ResourceSnapshot {
  current: ResourceSample | null;
  series: ResourceSample[];
  intervalMs: number;
}

interface BindingActivity {
  binding: string | null;
  label: string | null;
  execSessions: number;
  inFlightEvals: number;
  inFlightCalls: number;
  queuedCalls: number;
}

interface InFlightEval {
  exec: string;
  evalId: number;
  binding: string | null;
  workspace: string;
  async: boolean;
  startedAt: number;
  ageMs: number;
  timeoutMs?: number;
}

interface EvalSnapshot {
  total: number;
  items: InFlightEval[];
}

interface Snapshot {
  capacity: Record<string, number>;
  pool: PoolCounts;
  sessions: SessionCounts;
  servers: ServerSummary;
  bindings: BindingActivity[];
  resources: ResourceSnapshot | null;
  evals: EvalSnapshot | null;
}

interface RuntimeSettings {
  capacity?: Record<string, number>;
  strictAuth?: boolean;
  [key: string]: unknown;
}

interface ServerView {
  id: string;
  label: string;
  enabled: boolean;
  state: string;
  transport?: string;
  lastError?: string;
}

interface AlertConfig {
  enabled: boolean;
  webhookConfigured: boolean;
}

interface GuidanceState {
  /** User-configured servers only; the two builtin seed rows are filtered out. */
  servers: ServerView[] | null;
  clientsTotal: number | null;
  toolCount: number | null;
  alerts: AlertConfig | null;
  openReports: number | null;
  openReportsHasMore: boolean;
  pendingAnnotations: number | null;
  errors: string[];
}

const CAPACITY_LABELS: ReadonlyArray<{ key: string; label: string; hint: string }> = [
  { key: 'maxExecSessions', label: '执行会话', hint: '全进程上限' },
  { key: 'maxExecSessionsPerBinding', label: '每 binding 执行会话', hint: '单个客户端身份' },
  { key: 'maxServeProcesses', label: 'serve 组', hint: '1 组 = keeper + serve，约 2 个进程' },
  { key: 'maxWorkers', label: 'worker', hint: '全进程上限' },
  { key: 'maxInFlightEvalsPerExecSession', label: '每执行会话在飞 eval', hint: '异步派发后释放锁' },
  { key: 'maxInFlightEvalsPerBinding', label: '每 binding 在飞 eval', hint: '跨执行会话总量' },
  { key: 'maxInFlightCallsPerBindingPerServer', label: '每 binding × 服务端在飞调用', hint: '共享池公平性' },
  { key: 'maxQueuedCallsPerBindingPerServer', label: '每 binding × 服务端排队', hint: '超出返回 MCP_QUEUE_FULL' },
  { key: 'evictIdleMs', label: '容量淘汰空闲阈值', hint: '按 lastEvalAt 判定' },
];

const POLL_MS = 5_000;
const GUIDANCE_TTL_MS = 30_000;
const OPEN_REPORTS_LIMIT = 50;
const BUILTIN_SERVER_IDS: ReadonlySet<string> = new Set(['__official__', '__builtin__']);

type AttentionTone = 'error' | 'queue' | 'info' | 'ok';
type AttentionTarget = { path: '/reports'; status?: 'open' } | { path: '/manage'; tab: ManageTab };

interface AttentionItem {
  id: string;
  tone: AttentionTone;
  title: string;
  detail: string;
  actionLabel?: string;
  target?: AttentionTarget;
}

type OnboardingStepId = 'servers' | 'tools' | 'clients';
type OnboardingStatus = 'done' | 'todo' | 'unknown';

interface OnboardingStep {
  id: OnboardingStepId;
  status: OnboardingStatus;
  count: number | null;
}

interface OnboardingResult {
  steps: OnboardingStep[];
  completed: number;
  total: number;
  allDone: boolean;
}

interface Status {
  label: string;
  tone: Tone;
}

interface KpiOptions {
  label: string;
  value: string;
  hint: string;
  status: string;
  tone: Tone;
  progress?: number;
}

const EMPTY_GUIDANCE: GuidanceState = {
  servers: null,
  clientsTotal: null,
  toolCount: null,
  alerts: null,
  openReports: null,
  openReportsHasMore: false,
  pendingAnnotations: null,
  errors: [],
};

const TONE_COLORS: Readonly<Record<Tone, string>> = {
  ok: 'green',
  error: 'red',
  queue: 'gold',
  slow: 'orange',
  info: 'blue',
  neutral: 'default',
};

export function OverviewPage(): React.ReactElement {
  const api = useApi();
  const { message } = AntApp.useApp();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [guidance, setGuidance] = useState<GuidanceState>(EMPTY_GUIDANCE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  const guidanceInFlightRef = useRef(false);
  const guidanceLoadedAtRef = useRef<number | null>(null);
  const lastOverviewToastRef = useRef<string | null>(null);
  const lastSettingsToastRef = useRef<string | null>(null);
  const lastGuidanceToastRef = useRef<string | null>(null);

  const notify = useCallback(
    (source: 'overview' | 'settings' | 'guidance', text: string): void => {
      const ref =
        source === 'overview'
          ? lastOverviewToastRef
          : source === 'settings'
            ? lastSettingsToastRef
            : lastGuidanceToastRef;
      if (ref.current === text) return;
      ref.current = text;
      message.error(text);
    },
    [message],
  );

  const fetchToolCount = useCallback(
    async (serverId: string): Promise<number | null> => {
      try {
        const response = await api.get<unknown>(`/servers/${encodeURIComponent(serverId)}/tools`);
        if (!isRecord(response) || !Array.isArray(response['tools'])) return null;
        return response['tools'].length;
      } catch {
        return null;
      }
    },
    [api],
  );

  const loadGuidance = useCallback(async (): Promise<void> => {
    if (guidanceInFlightRef.current) return;
    guidanceInFlightRef.current = true;
    try {
      const [serversResult, clientsResult, alertsResult, reportsResult, pendingResult] =
        await Promise.allSettled([
          api.get<unknown>('/servers'),
          api.get<unknown>('/clients'),
          api.get<unknown>('/alerts/config'),
          api.get<unknown>('/reports', {
            query: { status: 'open', limit: OPEN_REPORTS_LIMIT },
          }),
          api.get<unknown>('/ai/annotations/pending'),
        ]);
      if (!aliveRef.current) return;

      const errors: string[] = [];
      const allServers = normalizeServers(settledValue(serversResult));
      const servers =
        allServers === null ? null : allServers.filter((server) => !isBuiltinServer(server));
      if (servers === null) errors.push(`服务端列表${settledProblem(serversResult)}`);

      const clientsTotal = countClients(settledValue(clientsResult));
      if (clientsTotal === null) errors.push(`客户端绑定${settledProblem(clientsResult)}`);

      const alerts = normalizeAlerts(settledValue(alertsResult));
      if (alerts === null) errors.push(`告警配置${settledProblem(alertsResult)}`);

      const reports = normalizeOpenReports(settledValue(reportsResult));
      if (reports === null) errors.push(`问题报告${settledProblem(reportsResult)}`);

      // The AI annotation endpoint is optional; a failed read only hides the hint.
      const pendingAnnotations = countPendingAnnotations(settledValue(pendingResult));

      let toolCount: number | null = null;
      if (servers !== null) {
        if (servers.length === 0) {
          toolCount = 0;
        } else {
          const counts = await Promise.all(servers.map((server) => fetchToolCount(server.id)));
          if (!aliveRef.current) return;
          const known = counts.filter((count): count is number => count !== null);
          if (known.length < counts.length) errors.push('部分服务端的工具目录读取失败');
          toolCount = known.length === 0 ? null : known.reduce((sum, count) => sum + count, 0);
        }
      }

      guidanceLoadedAtRef.current = Date.now();
      setGuidance({
        servers,
        clientsTotal,
        toolCount,
        alerts,
        openReports: reports?.count ?? null,
        openReportsHasMore: reports?.hasMore ?? false,
        pendingAnnotations,
        errors,
      });
      if (errors.length > 0) notify('guidance', `部分检查数据读取失败：${errors.join('；')}`);
      else lastGuidanceToastRef.current = null;
    } finally {
      guidanceInFlightRef.current = false;
    }
  }, [api, fetchToolCount, notify]);

  const loadSnapshot = useCallback(async (): Promise<void> => {
    try {
      const response = await api.get<unknown>('/overview');
      if (!aliveRef.current) return;
      setSnapshot(normalizeSnapshot(response));
      setOverviewError(null);
      lastOverviewToastRef.current = null;
      setLastUpdated(Date.now());
    } catch (error) {
      if (!aliveRef.current) return;
      const text = failureText(error);
      setOverviewError(text);
      notify('overview', `概览加载失败：${text}`);
    }

    try {
      const response = await api.get<unknown>('/settings');
      if (!aliveRef.current) return;
      setSettings(normalizeSettings(response));
      setSettingsError(null);
      lastSettingsToastRef.current = null;
    } catch (error) {
      if (!aliveRef.current) return;
      const text = failureText(error);
      setSettings(null);
      setSettingsError(text);
      notify('settings', `容量设置读取失败（仅快照生效值可用）：${text}`);
    }
  }, [api, notify]);

  const load = useCallback(
    async (forceGuidance: boolean): Promise<void> => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      try {
        const loadedAt = guidanceLoadedAtRef.current;
        const needGuidance =
          forceGuidance || loadedAt === null || Date.now() - loadedAt >= GUIDANCE_TTL_MS;
        const guidanceTask = needGuidance ? loadGuidance() : Promise.resolve();
        await loadSnapshot();
        if (!aliveRef.current) return;
        setLoading(false);
        // Paint the live cards first; guidance may still be counting tools.
        try {
          await guidanceTask;
        } catch {
          // loadGuidance records per-source errors; keep the previous guidance on a crash.
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [loadGuidance, loadSnapshot],
  );

  useEffect(() => {
    aliveRef.current = true;
    void load(true);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(false);
    }, POLL_MS);
    const onRefresh = (): void => refresh();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void load(false);
    };
    window.addEventListener('repl:refresh', onRefresh);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      aliveRef.current = false;
      window.clearInterval(timer);
      window.removeEventListener('repl:refresh', onRefresh);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  function go(target: AttentionTarget): void {
    if (target.path === '/reports') {
      const next = target.status === undefined ? '#/reports' : `#/reports?status=${target.status}`;
      if (window.location.hash !== next) window.location.hash = next;
      return;
    }
    navigate('/manage', target.tab);
  }

  function refresh(): void {
    setRefreshing(true);
    void load(true).finally(() => {
      if (aliveRef.current) setRefreshing(false);
    });
  }

  const capacity = mergeCapacity(snapshot?.capacity, settings?.capacity);
  const serversTotal = guidance.servers === null ? null : guidance.servers.length;
  const onboarding = evaluateOnboarding({
    serversTotal,
    toolCount: guidance.toolCount,
    clientsTotal: guidance.clientsTotal,
  });
  const attention = evaluateAttention({
    servers: guidance.servers,
    serverSummary: snapshot?.servers ?? null,
    alerts: guidance.alerts,
    openReports: guidance.openReports,
    openReportsHasMore: guidance.openReportsHasMore,
    pendingAnnotations: guidance.pendingAnnotations,
  });
  const attentionTone: Tone = attention.some((item) => item.tone === 'error')
    ? 'error'
    : attention.some((item) => item.tone === 'queue') || guidance.errors.length > 0
      ? 'queue'
      : attention.length === 0
        ? 'ok'
        : 'info';
  const attentionBadge =
    attention.length === 0
      ? guidance.errors.length === 0
        ? '全部正常'
        : '数据不完整'
      : `${attention.length} 项`;

  const header = (
    <PageHeader
      title="概览"
      description="先看「需要关注」，再看进程、容量、连接池与活跃会话；每 5 秒刷新，页面隐藏时暂停。"
      actions={
        <Button icon={<ReloadOutlined />} loading={refreshing} onClick={refresh}>
          刷新
        </Button>
      }
    />
  );

  if (snapshot === null) {
    return (
      <div className="page">
        {header}
        {overviewError === null ? null : (
          <Alert
            type="error"
            showIcon
            message="概览加载失败"
            description={overviewError}
            action={
              <Button size="small" onClick={() => void load(true)}>
                重试
              </Button>
            }
          />
        )}
        {loading && overviewError === null ? (
          <Spin style={{ display: 'block', margin: '48px auto' }} />
        ) : (
          <Card>
            <Empty description="尚未取得概览数据。">
              <Button type="primary" icon={<ReloadOutlined />} onClick={() => void load(true)}>
                重试
              </Button>
            </Empty>
          </Card>
        )}
      </div>
    );
  }

  return (
    <div className="page">
      {header}
      {overviewError === null ? null : (
        <Alert
          type="error"
          showIcon
          message="概览加载失败"
          description={overviewError}
          action={
            <Button size="small" onClick={() => void load(true)}>
              重试
            </Button>
          }
        />
      )}
      {settingsError === null ? null : (
        <Alert
          type="warning"
          showIcon
          message="部分容量项读取失败（仅快照生效值可用）"
          description={settingsError}
        />
      )}
      {lastUpdated === null ? null : (
        <Text type="secondary" style={{ fontSize: 11.5 }}>
          更新于 {formatTimestamp(lastUpdated)} · 数据源 /admin/api/overview
        </Text>
      )}

      <Card title="需要关注" extra={<Tag color={TONE_COLORS[attentionTone]}>{attentionBadge}</Tag>}>
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          {attention.length === 0 ? (
            <Alert
              type={guidance.errors.length === 0 ? 'success' : 'info'}
              showIcon
              message={guidance.errors.length === 0 ? '暂无需要关注的问题' : '检查数据不完整'}
              description={
                guidance.errors.length === 0
                  ? '服务端状态、告警开关与问题报告均未发现异常。'
                  : '部分来源读取失败，刷新后重试；已读取到的来源未发现异常。'
              }
            />
          ) : (
            attention.map((item) => {
              const target = item.target;
              return (
                <Alert
                  key={item.id}
                  type={alertType(item.tone)}
                  showIcon
                  message={item.title}
                  description={item.detail}
                  action={
                    target === undefined || item.actionLabel === undefined ? null : (
                      <Button size="small" onClick={() => go(target)}>
                        {item.actionLabel}
                      </Button>
                    )
                  }
                />
              );
            })
          )}
          {guidance.errors.length === 0 ? null : (
            <Text type="secondary" style={{ fontSize: 11.5 }}>
              部分数据读取失败，已跳过对应检查：{guidance.errors.join('；')}
            </Text>
          )}
        </Space>
      </Card>

      <KpiSection snapshot={snapshot} capacity={capacity} toolCount={guidance.toolCount} />

      <CapacitySection capacity={capacity} settingsAvailable={settings !== null} />

      <ResourceSection resources={snapshot.resources} />

      <BindingActivitySection bindings={snapshot.bindings} />

      <EvalActivitySection
        evals={snapshot.evals}
        bindings={snapshot.bindings}
        onCancelled={() => void load(false)}
      />

      {onboarding.allDone ? (
        <Card size="small">
          <Space>
            <Tag color="success">已完成初始配置</Tag>
            <Text type="secondary">
              {onboarding.completed}/{onboarding.total} 步已完成 · 到「连接」和「配置」可复查
            </Text>
          </Space>
        </Card>
      ) : (
        <Card
          title="开始使用"
          extra={
            <Tag color={onboarding.completed > 0 ? 'blue' : 'default'}>
              {onboarding.completed}/{onboarding.total} 步已完成
            </Tag>
          }
        >
          <Steps
            size="small"
            items={onboarding.steps.map((step) => {
              const meta = stepMeta(step.id);
              const description =
                step.status === 'done'
                  ? stepDoneDetail(step)
                  : step.status === 'unknown'
                    ? meta.unknownDetail
                    : stepTodoDetail(step.id);
              return {
                status:
                  step.status === 'done' ? 'finish' : step.status === 'unknown' ? 'wait' : 'process',
                title: meta.title,
                description: (
                  <Space direction="vertical" size={2}>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                      {description}
                    </Text>
                    <Button
                      type="link"
                      size="small"
                      style={{ padding: 0, height: 'auto' }}
                      onClick={() => go(meta.target)}
                    >
                      {meta.actionLabel}
                    </Button>
                  </Space>
                ),
              };
            })}
          />
        </Card>
      )}

      <Card title="运行提示">
        <Space direction="vertical" size={8} style={{ width: '100%' }}>
          <Alert
            type={settings?.strictAuth === true ? 'warning' : 'info'}
            showIcon
            message={
              settings?.strictAuth === undefined
                ? '鉴权模式未知'
                : settings.strictAuth
                  ? '严格鉴权模式'
                  : '宽松鉴权模式'
            }
            description={
              settings?.strictAuth === undefined
                ? '/mcp 默认宽松，未知 token 仍返回 401。'
                : settings.strictAuth
                  ? '未带 token 的 /mcp 请求直接 401。'
                  : '未带 token 记为 unbound；未知或格式错的 token 仍返回 401。'
            }
          />
          <Alert
            type="info"
            showIcon
            message="容量淘汰"
            description="按 lastEvalAt 判定，只回收无在飞 eval 且空闲超过 evictIdleMs 的执行会话。"
          />
          <Alert
            type="info"
            showIcon
            message="连接与 catalog"
            description="连接状态是实时的，catalog 在 eval 开始时快照；两者不一致时按“暂时不可用”处理。"
          />
        </Space>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

function KpiSection({
  snapshot,
  capacity,
  toolCount,
}: {
  snapshot: Snapshot;
  capacity: CapacityView;
  toolCount: number | null;
}): React.ReactElement {
  const sessions = snapshot.sessions;
  const execLimit = capacity.values['maxExecSessions'];
  const execLimitSource = capacity.sources['maxExecSessions'];
  const sessionTotal = sessions.transport + sessions.exec;
  const execRatio = execLimit !== undefined && execLimit > 0 ? sessions.exec / execLimit : null;

  const serverState = serverStatus(snapshot.servers);
  const capacityState = capacityStatus(execLimit, execRatio);
  const poolState = poolStatus(snapshot.pool);
  const sessionState = sessionStatus(sessions, sessionTotal);

  const capacityHint =
    execLimit === undefined
      ? '执行会话占用（上限不可用）'
      : execRatio === null
        ? '执行会话占用；上限为 0'
        : `占用 ${formatPercent(execRatio, 0)} · 上限来自 ${
            execLimitSource === 'settings' ? '/settings 设置值' : '/overview 生效值'
          }`;

  const sessionHint = [
    `传输 ${formatNumber(sessions.transport)}`,
    `执行 ${formatNumber(sessions.exec)}`,
    `在飞 eval ${formatNumber(sessions.inFlightEvals)}`,
  ];

  const toolState: Status =
    toolCount === null
      ? { label: '目录未知', tone: 'neutral' }
      : toolCount > 0
        ? { label: '已发现', tone: 'ok' }
        : { label: '未发现', tone: 'queue' };

  return (
    <Row gutter={[12, 12]}>
      <Col xs={24} sm={12} xl={8}>
        <KpiCard
          label="服务端"
          value={`${formatNumber(snapshot.servers.enabled)} / ${formatNumber(snapshot.servers.total)}`}
          hint={`已启用 ${formatNumber(snapshot.servers.enabled)} · 已注册 ${formatNumber(snapshot.servers.total)} · 池连接 ${formatNumber(snapshot.pool.total)}`}
          status={serverState.label}
          tone={serverState.tone}
        />
      </Col>
      <Col xs={24} sm={12} xl={8}>
        <KpiCard
          label="工具"
          value={toolCount === null ? '—' : formatNumber(toolCount)}
          hint={
            toolCount === null
              ? '工具目录暂不可用；接入服务端后刷新工具。'
              : '已接入服务端的工具目录合计'
          }
          status={toolState.label}
          tone={toolState.tone}
        />
      </Col>
      <Col xs={24} sm={12} xl={8}>
        <KpiCard
          label="活跃会话"
          value={formatNumber(sessionTotal)}
          hint={sessionHint.join(' · ')}
          status={sessionState.label}
          tone={sessionState.tone}
        />
      </Col>
      <Col xs={24} sm={12} xl={8}>
        <KpiCard
          label="连接池"
          value={`${formatNumber(snapshot.pool.ready)} / ${formatNumber(snapshot.pool.total)}`}
          hint={`ready ${formatNumber(snapshot.pool.ready)} · reconnecting ${formatNumber(snapshot.pool.reconnecting)} · failed ${formatNumber(snapshot.pool.failed)}`}
          status={poolState.label}
          tone={poolState.tone}
        />
      </Col>
      <Col xs={24} sm={12} xl={8}>
        <KpiCard
          label="容量占用"
          value={
            execLimit === undefined
              ? formatNumber(sessions.exec)
              : `${formatNumber(sessions.exec)} / ${formatNumber(execLimit)}`
          }
          hint={capacityHint}
          status={capacityState.label}
          tone={capacityState.tone}
          progress={execRatio === null ? undefined : execRatio}
        />
      </Col>
    </Row>
  );
}

function KpiCard({ label, value, hint, status, tone, progress }: KpiOptions): React.ReactElement {
  return (
    <Card size="small" style={{ height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Text>
        <Tag color={TONE_COLORS[tone]} bordered={false}>
          {status}
        </Tag>
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 650,
          lineHeight: 1.25,
          letterSpacing: '-0.02em',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </div>
      <Text type="secondary" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
        {hint}
      </Text>
      {progress === undefined ? null : (
        <Progress
          percent={Math.round(Math.min(1, Math.max(0, progress)) * 100)}
          showInfo={false}
          size="small"
          status={progress >= 1 ? 'exception' : 'normal'}
          style={{ marginTop: 4 }}
        />
      )}
    </Card>
  );
}

function CapacitySection({
  capacity,
  settingsAvailable,
}: {
  capacity: CapacityView;
  settingsAvailable: boolean;
}): React.ReactElement {
  const settingsCount = Object.values(capacity.sources).filter(
    (source) => source === 'settings',
  ).length;
  const stateLabel = !settingsAvailable
    ? '仅快照生效值'
    : settingsCount > 0
      ? `${settingsCount} 项来自设置`
      : '全部为生效值';

  return (
    <Card
      title="容量生效值"
      extra={
        <Tag color={!settingsAvailable ? 'gold' : settingsCount === 0 ? 'green' : 'default'}>
          {stateLabel}
        </Tag>
      }
    >
      <Text type="secondary" style={{ fontSize: 12 }}>
        以 /overview 快照为准（运行时实际生效值）；快照未覆盖的项用 /settings 设置值补齐并标注。
      </Text>
      <Row gutter={[12, 12]} style={{ marginTop: 10 }}>
        {CAPACITY_LABELS.map((entry) => {
          const value = capacity.values[entry.key];
          const source = capacity.sources[entry.key];
          return (
            <Col xs={24} md={12} xl={8} key={entry.key}>
              <Card size="small" style={{ height: '100%' }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    justifyContent: 'space-between',
                    gap: 12,
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 550 }}>{entry.label}</div>
                    <Mono>{entry.key}</Mono>
                  </div>
                  <Space size={8} style={{ flex: '0 0 auto' }}>
                    <span
                      style={{
                        fontSize: 20,
                        fontWeight: 650,
                        lineHeight: 1.2,
                        letterSpacing: '-0.02em',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {value === undefined ? '—' : formatNumber(value)}
                    </span>
                    {source === 'settings' ? (
                      <Tag bordered={false}>设置值</Tag>
                    ) : source === undefined ? (
                      <Tag bordered={false}>不可用</Tag>
                    ) : null}
                  </Space>
                </div>
                <Text type="secondary" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
                  {entry.hint}
                </Text>
              </Card>
            </Col>
          );
        })}
      </Row>
    </Card>
  );
}

function ResourceSection({
  resources,
}: {
  resources: ResourceSnapshot | null;
}): React.ReactElement {
  const current = resources?.current ?? null;
  const series = resources?.series ?? [];
  const intervalSeconds = resources === null ? null : Math.round(resources.intervalMs / 1000);
  const intervalLabel =
    intervalSeconds === null || intervalSeconds <= 0
      ? '不可用'
      : `每 ${formatNumber(intervalSeconds)} 秒采样 · 保留 30 分钟`;

  return (
    <Card title="资源" extra={<Tag bordered={false}>{intervalLabel}</Tag>}>
      <Row gutter={[12, 12]}>
        <ResourceMetric
          label="总 RSS"
          value={current === null ? '—' : formatBytes(current.totalRssBytes)}
          hint="主进程 + 子进程"
        />
        <ResourceMetric
          label="主进程 RSS"
          value={current === null ? '—' : formatBytes(current.selfRssBytes)}
          hint="含 worker_threads"
        />
        <ResourceMetric
          label="子进程 RSS"
          value={current === null ? '—' : formatBytes(current.childRssBytes)}
          hint={current === null ? 'keeper / serve / 第三方 server' : `${formatNumber(current.childCount)} 个子进程`}
        />
        <ResourceMetric
          label="总 CPU"
          value={current === null ? '—' : formatCpu(current.totalCpuPercent)}
          hint="单核百分比口径"
        />
        <ResourceMetric
          label="主进程 CPU"
          value={current === null ? '—' : formatCpu(current.selfCpuPercent)}
          hint="两次采样差值的区间值"
        />
        <ResourceMetric
          label="子进程 CPU"
          value={current === null ? '—' : formatCpu(current.childCpuPercent)}
          hint="ps %cpu 之和，非区间瞬时值"
        />
      </Row>
      <Row gutter={[12, 12]} style={{ marginTop: 10 }}>
        <Col xs={24} xl={12}>
          <Sparkline
            label="总 RSS 趋势"
            samples={series.map((sample) => ({
              ts: sample.ts,
              value: sample.totalRssBytes,
            }))}
            format={formatBytes}
          />
        </Col>
        <Col xs={24} xl={12}>
          <Sparkline
            label="总 CPU 趋势"
            samples={series.map((sample) => ({
              ts: sample.ts,
              value: sample.totalCpuPercent,
            }))}
            format={formatCpu}
          />
        </Col>
      </Row>
    </Card>
  );
}

function BindingActivitySection({
  bindings,
}: {
  bindings: readonly BindingActivity[];
}): React.ReactElement {
  return (
    <Card title="实时并发" extra={<Tag bordered={false}>每 5 秒刷新</Tag>}>
      <Table
        size="small"
        rowKey={(row) => row.binding ?? 'unbound'}
        dataSource={bindings}
        pagination={false}
        locale={{ emptyText: '当前没有活跃 binding' }}
        columns={[
          {
            title: 'Binding',
            dataIndex: 'binding',
            render: (_value: string | null, row: BindingActivity) =>
              row.binding === null ? (
                <Text type="secondary">未绑定</Text>
              ) : (
                <Space direction="vertical" size={0}>
                  <Text>{row.label ?? row.binding}</Text>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    <Mono>{row.binding}</Mono>
                  </Text>
                </Space>
              ),
          },
          { title: '执行会话', dataIndex: 'execSessions', align: 'right' },
          { title: '在飞 eval', dataIndex: 'inFlightEvals', align: 'right' },
          { title: '在飞调用', dataIndex: 'inFlightCalls', align: 'right' },
          { title: '排队调用', dataIndex: 'queuedCalls', align: 'right' },
        ]}
      />
    </Card>
  );
}

function EvalActivitySection({
  evals,
  bindings,
  onCancelled,
}: {
  evals: EvalSnapshot | null;
  bindings: readonly BindingActivity[];
  onCancelled: () => void;
}): React.ReactElement {
  const api = useApi();
  const { message } = AntApp.useApp();
  const [cancelling, setCancelling] = useState<ReadonlySet<string>>(() => new Set());

  const labels = new Map<string, string | null>();
  for (const entry of bindings) {
    if (entry.binding !== null) labels.set(entry.binding, entry.label);
  }
  const items = evals?.items ?? [];

  function setBusy(key: string, busy: boolean): void {
    setCancelling((current) => {
      const next = new Set(current);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  async function cancel(row: InFlightEval): Promise<void> {
    const key = evalKey(row);
    if (cancelling.has(key)) return;
    setBusy(key, true);
    try {
      await api.post(`/evals/${encodeURIComponent(row.exec)}/${row.evalId}/cancel`);
      message.success(`已取消 eval ${row.evalId}`);
      onCancelled();
    } catch (error) {
      message.error(`取消失败：${failureText(error)}`);
    } finally {
      setBusy(key, false);
    }
  }

  return (
    <Card
      title="在飞 eval"
      extra={
        <Tag bordered={false}>
          {evals === null ? '数据不可用' : `共 ${formatNumber(evals.total)} 个`}
        </Tag>
      }
    >
      <Table
        size="small"
        rowKey={evalKey}
        dataSource={items}
        pagination={false}
        locale={{ emptyText: '当前没有在飞 eval' }}
        columns={[
          {
            title: '执行会话',
            dataIndex: 'exec',
            render: (value: string) => <Mono>{value}</Mono>,
          },
          { title: 'evalId', dataIndex: 'evalId', align: 'right' },
          {
            title: 'Binding',
            dataIndex: 'binding',
            render: (_value: string | null, row: InFlightEval) => {
              if (row.binding === null) return <Text type="secondary">未绑定</Text>;
              const label = labels.get(row.binding);
              return label === null || label === undefined ? (
                <Mono>{row.binding}</Mono>
              ) : (
                <Text>{label}</Text>
              );
            },
          },
          {
            title: 'workspace',
            dataIndex: 'workspace',
            render: (value: string) => <Mono>{value}</Mono>,
          },
          {
            title: '已运行',
            dataIndex: 'ageMs',
            align: 'right',
            render: (value: number) => formatDuration(value),
          },
          {
            title: '类型',
            dataIndex: 'async',
            render: (value: boolean) => (
              <Tag bordered={false}>{value ? 'async' : 'sync'}</Tag>
            ),
          },
          {
            title: '操作',
            key: 'action',
            render: (_value: unknown, row: InFlightEval) => {
              const busy = cancelling.has(evalKey(row));
              return (
                <Popconfirm
                  title={`取消 eval ${row.evalId}？`}
                  description="协作取消失败时会在约 2 秒后重启该执行会话的 worker，同一执行会话内的其它在飞 eval 也会被终止。"
                  okText="取消 eval"
                  cancelText="返回"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => cancel(row)}
                >
                  <Button size="small" danger loading={busy} disabled={busy}>
                    取消
                  </Button>
                </Popconfirm>
              );
            },
          },
        ]}
      />
    </Card>
  );
}

function evalKey(row: InFlightEval): string {
  return `${row.exec}:${row.evalId}`;
}

function ResourceMetric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}): React.ReactElement {
  return (
    <Col xs={24} sm={12} xl={8}>
      <Card size="small" style={{ height: '100%' }}>
        <Text type="secondary" style={{ fontSize: 12 }}>
          {label}
        </Text>
        <div
          style={{
            fontSize: 22,
            fontWeight: 650,
            lineHeight: 1.25,
            letterSpacing: '-0.02em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </div>
        <Text type="secondary" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
          {hint}
        </Text>
      </Card>
    </Col>
  );
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 120;
const CHART_MARGIN = { top: 10, right: 10, bottom: 22, left: 46 };

function formatClock(ts: number): string {
  const date = new Date(ts);
  const two = (value: number): string => String(value).padStart(2, '0');
  return `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
}

function Sparkline({
  label,
  samples,
  format,
}: {
  label: string;
  samples: readonly { ts: number; value: number }[];
  format: (value: number) => string;
}): React.ReactElement {
  const { token } = theme.useToken();

  if (samples.length === 0) {
    return (
      <Card size="small" title={label}>
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无采样" />
      </Card>
    );
  }

  const values = samples.map((sample) => sample.value);
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = (rawMax - rawMin) * 0.08 || Math.max(Math.abs(rawMax) * 0.05, 1);
  const min = Math.max(0, rawMin - padding);
  const max = rawMax + padding;

  const plotLeft = CHART_MARGIN.left;
  const plotTop = CHART_MARGIN.top;
  const plotWidth = CHART_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const plotHeight = CHART_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const plotBottom = plotTop + plotHeight;
  const xAt = (index: number): number =>
    samples.length === 1
      ? plotLeft + plotWidth / 2
      : plotLeft + (index / (samples.length - 1)) * plotWidth;
  const yAt = (value: number): number =>
    plotTop + (1 - (value - min) / (max - min)) * plotHeight;

  const points = samples
    .map((sample, index) => `${xAt(index).toFixed(1)},${yAt(sample.value).toFixed(1)}`)
    .join(' ');
  const yTicks = [max, (min + max) / 2, min];
  const xTickIndexes = [...new Set([0, Math.floor((samples.length - 1) / 2), samples.length - 1])];

  return (
    <Card
      size="small"
      title={label}
      extra={
        <Text type="secondary" style={{ fontSize: 11.5 }}>
          最大 {format(rawMax)} · 最小 {format(rawMin)}
        </Text>
      }
    >
      <svg
        role="img"
        aria-label={label}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        style={{ display: 'block', width: '100%', height: 'auto' }}
      >
        {yTicks.map((tick) => (
          <g key={tick}>
            <line
              x1={plotLeft}
              x2={plotLeft + plotWidth}
              y1={yAt(tick)}
              y2={yAt(tick)}
              stroke={token.colorBorderSecondary}
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={plotLeft - 6}
              y={yAt(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={8.5}
              fill={token.colorTextTertiary}
            >
              {format(tick)}
            </text>
          </g>
        ))}
        <line
          x1={plotLeft}
          x2={plotLeft}
          y1={plotTop}
          y2={plotBottom}
          stroke={token.colorBorder}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={plotLeft}
          x2={plotLeft + plotWidth}
          y1={plotBottom}
          y2={plotBottom}
          stroke={token.colorBorder}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
        {xTickIndexes.map((index) => {
          const sample = samples[index];
          if (sample === undefined) return null;
          return (
            <text
              key={index}
              x={xAt(index)}
              y={CHART_HEIGHT - 6}
              textAnchor={
                samples.length === 1
                  ? 'middle'
                  : index === 0
                    ? 'start'
                    : index === samples.length - 1
                      ? 'end'
                      : 'middle'
              }
              fontSize={8.5}
              fill={token.colorTextTertiary}
            >
              {formatClock(sample.ts)}
            </text>
          );
        })}
        <polyline
          points={points}
          fill="none"
          stroke={token.colorPrimary}
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    </Card>
  );
}

function formatCpu(value: number): string {
  return `${formatNumber(Math.round(value * 10) / 10)}%`;
}

// ---------------------------------------------------------------------------
// Attention and onboarding logic
// ---------------------------------------------------------------------------

function evaluateAttention(input: {
  servers: readonly ServerView[] | null;
  serverSummary: ServerSummary | null;
  alerts: AlertConfig | null;
  openReports: number | null;
  openReportsHasMore: boolean;
  pendingAnnotations: number | null;
}): AttentionItem[] {
  const items: AttentionItem[] = [];
  const manageServers: AttentionTarget = { path: '/manage', tab: 'servers' };
  const manageAlerts: AttentionTarget = { path: '/manage', tab: 'alerts' };

  if (input.servers !== null) {
    if (input.servers.length === 0) {
      items.push({
        id: 'servers-empty',
        tone: 'info',
        title: '还没有接入服务端',
        detail: '先添加一个 MCP 服务端，连接并在「工具」页刷新后才能发现工具。',
        actionLabel: '去接入',
        target: manageServers,
      });
    } else {
      const disabled = input.servers.filter(
        (server) => !server.enabled || server.state === 'disabled',
      );
      if (disabled.length > 0) {
        items.push({
          id: 'servers-disabled',
          tone: 'queue',
          title: `${formatNumber(disabled.length)} 个服务端已停用`,
          detail: '停用的服务端不会暴露工具，也不会接新调用。',
          actionLabel: '去启用',
          target: manageServers,
        });
      }

      const failed = input.servers.filter(
        (server) => server.enabled && server.state === 'failed',
      );
      if (failed.length > 0) {
        const first = failed[0];
        items.push({
          id: 'servers-failed',
          tone: 'error',
          title: `${formatNumber(failed.length)} 个服务端连接失败`,
          detail:
            first?.lastError === undefined
              ? '检查命令、URL 与凭据后重启服务端。'
              : `最近的错误：${first.lastError}`,
          actionLabel: '查看并重启',
          target: manageServers,
        });
      }

      const unstable = input.servers.filter(
        (server) =>
          server.enabled && (server.state === 'reconnecting' || server.state === 'degraded'),
      );
      if (unstable.length > 0) {
        items.push({
          id: 'servers-unstable',
          tone: 'queue',
          title: `${formatNumber(unstable.length)} 个服务端连接不稳定`,
          detail: '重连或降级期间，工具调用可能失败或变慢。',
          actionLabel: '查看状态',
          target: manageServers,
        });
      }
    }
  } else if (input.serverSummary !== null) {
    const disabled = input.serverSummary.total - input.serverSummary.enabled;
    if (disabled > 0) {
      items.push({
        id: 'servers-disabled-summary',
        tone: 'queue',
        title: `${formatNumber(disabled)} 个服务端已停用`,
        detail: '服务端明细暂不可用；到管理页确认哪些服务端被停用。',
        actionLabel: '去查看',
        target: manageServers,
      });
    }
  }

  if (input.alerts !== null) {
    if (!input.alerts.enabled) {
      items.push({
        id: 'alerts-disabled',
        tone: 'queue',
        title: '告警未启用',
        detail: '问题报告不会通过 webhook 推送。',
        actionLabel: '去配置',
        target: manageAlerts,
      });
    } else if (!input.alerts.webhookConfigured) {
      items.push({
        id: 'alerts-webhook-missing',
        tone: 'queue',
        title: '告警 webhook 未配置',
        detail: '告警已启用，但没有 webhook 地址，通知无法发出。',
        actionLabel: '去配置',
        target: manageAlerts,
      });
    }
  }

  if (input.openReports !== null && input.openReports > 0) {
    items.push({
      id: 'reports-open',
      tone: 'queue',
      title: `${formatNumber(input.openReports)} 条问题报告未处理`,
      detail: input.openReportsHasMore
        ? '还有更多未处理报告；确认或关闭后才会离开列表。'
        : '未处理的报告需要确认或关闭。',
      actionLabel: '去处理',
      target: { path: '/reports', status: 'open' },
    });
  }

  if (input.pendingAnnotations !== null && input.pendingAnnotations > 0) {
    items.push({
      id: 'annotations-pending',
      tone: 'queue',
      title: `${formatNumber(input.pendingAnnotations)} 条 AI 标注待处理`,
      detail: '新接入服务端自动生成的摘要与标签建议等待审阅。',
      actionLabel: '去审阅',
      target: { path: '/manage', tab: 'ai' },
    });
  }

  return items;
}

function alertType(tone: AttentionTone): 'error' | 'warning' | 'info' | 'success' {
  if (tone === 'error') return 'error';
  if (tone === 'queue') return 'warning';
  if (tone === 'ok') return 'success';
  return 'info';
}

function evaluateOnboarding(input: {
  serversTotal: number | null;
  toolCount: number | null;
  clientsTotal: number | null;
}): OnboardingResult {
  const statusOf = (count: number | null): OnboardingStatus =>
    count === null ? 'unknown' : count > 0 ? 'done' : 'todo';
  const steps: OnboardingStep[] = [
    { id: 'servers', status: statusOf(input.serversTotal), count: input.serversTotal },
    { id: 'tools', status: statusOf(input.toolCount), count: input.toolCount },
    { id: 'clients', status: statusOf(input.clientsTotal), count: input.clientsTotal },
  ];
  const completed = steps.filter((step) => step.status === 'done').length;
  return {
    steps,
    completed,
    total: steps.length,
    allDone: completed === steps.length && steps.every((step) => step.status !== 'unknown'),
  };
}

function stepMeta(id: OnboardingStepId): {
  title: string;
  actionLabel: string;
  target: AttentionTarget;
  unknownDetail: string;
} {
  switch (id) {
    case 'servers':
      return {
        title: '接入一个服务端',
        actionLabel: '去接入',
        target: { path: '/manage', tab: 'servers' },
        unknownDetail: '服务端列表暂不可用，刷新后重试。',
      };
    case 'tools':
      return {
        title: '测试连接并刷新工具',
        actionLabel: '去测试',
        target: { path: '/manage', tab: 'tools' },
        unknownDetail: '工具目录暂不可用，刷新后重试。',
      };
    case 'clients':
      return {
        title: '创建客户端 token 接入',
        actionLabel: '去创建',
        target: { path: '/manage', tab: 'clients' },
        unknownDetail: '客户端绑定暂不可用，刷新后重试。',
      };
  }
}

function stepTodoDetail(id: OnboardingStepId): string {
  switch (id) {
    case 'servers':
      return '还没有注册服务端。';
    case 'tools':
      return '工具数为 0；连接服务端后点「刷新工具」。';
    case 'clients':
      return '还没有客户端绑定；token 保存在本机，可在 MCP 配置里随时查看/复制。';
  }
}

function stepDoneDetail(step: OnboardingStep): string {
  const amount = step.count === null ? '未知' : formatNumber(step.count);
  switch (step.id) {
    case 'servers':
      return `已注册 ${amount} 个服务端。`;
    case 'tools':
      return `工具目录里有 ${amount} 个工具。`;
    case 'clients':
      return `已有 ${amount} 个客户端绑定。`;
  }
}

// ---------------------------------------------------------------------------
// Live snapshot status
// ---------------------------------------------------------------------------

function serverStatus(servers: ServerSummary): Status {
  if (servers.total === 0) return { label: '无服务', tone: 'neutral' };
  if (servers.enabled === 0) return { label: '全部停用', tone: 'queue' };
  if (servers.enabled < servers.total) return { label: '部分启用', tone: 'info' };
  return { label: '全部启用', tone: 'ok' };
}

function capacityStatus(execLimit: number | undefined, ratio: number | null): Status {
  if (execLimit === undefined) return { label: '上限未知', tone: 'neutral' };
  if (ratio === null) return { label: '上限为 0', tone: 'queue' };
  if (ratio >= 1) return { label: '已满', tone: 'error' };
  if (ratio >= 0.8) return { label: '接近上限', tone: 'queue' };
  return { label: '充裕', tone: 'ok' };
}

function poolStatus(pool: PoolCounts): Status {
  if (pool.total === 0) return { label: '无连接', tone: 'neutral' };
  if (pool.failed > 0) return { label: '有失败', tone: 'error' };
  if (pool.reconnecting > 0) return { label: '重连中', tone: 'queue' };
  if (pool.ready < pool.total) return { label: '部分就绪', tone: 'info' };
  return { label: '全部就绪', tone: 'ok' };
}

function sessionStatus(sessions: SessionCounts, total: number): Status {
  if (total === 0) return { label: '空闲', tone: 'neutral' };
  if (sessions.inFlightEvals > 0) return { label: '有在飞 eval', tone: 'info' };
  return { label: '活跃', tone: 'ok' };
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

interface CapacityView {
  values: Record<string, number>;
  sources: Record<string, 'effective' | 'settings'>;
}

function mergeCapacity(
  effective: Record<string, number> | undefined,
  settings: Record<string, number> | undefined,
): CapacityView {
  const values = finiteNumbers(settings);
  const sources: Record<string, 'effective' | 'settings'> = {};
  for (const key of Object.keys(values)) sources[key] = 'settings';
  for (const [key, value] of Object.entries(finiteNumbers(effective))) {
    values[key] = value;
    sources[key] = 'effective';
  }
  return { values, sources };
}

function finiteNumbers(source: unknown): Record<string, number> {
  const values: Record<string, number> = {};
  if (!isRecord(source)) return values;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'number' && Number.isFinite(value)) values[key] = value;
  }
  return values;
}

function normalizeSnapshot(value: unknown): Snapshot {
  const record = isRecord(value) ? value : {};
  const pool = isRecord(record['pool']) ? record['pool'] : {};
  const sessions = isRecord(record['sessions']) ? record['sessions'] : {};
  const servers = isRecord(record['servers']) ? record['servers'] : {};
  return {
    capacity: finiteNumbers(record['capacity']),
    pool: {
      total: numberOrZero(pool['total']),
      ready: numberOrZero(pool['ready']),
      reconnecting: numberOrZero(pool['reconnecting']),
      failed: numberOrZero(pool['failed']),
    },
    sessions: {
      transport: numberOrZero(sessions['transport']),
      exec: numberOrZero(sessions['exec']),
      inFlightEvals: numberOrZero(sessions['inFlightEvals']),
    },
    servers: {
      total: numberOrZero(servers['total']),
      enabled: numberOrZero(servers['enabled']),
    },
    bindings: normalizeBindings(record['bindings']),
    resources: normalizeResources(record['resources']),
    evals: normalizeEvals(record['evals']),
  };
}

function normalizeEvals(value: unknown): EvalSnapshot | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const items: InFlightEval[] = [];
  for (const entry of value['items']) {
    if (!isRecord(entry)) continue;
    const exec = typeof entry['exec'] === 'string' ? entry['exec'] : '';
    const evalId = numberOrZero(entry['evalId']);
    if (exec === '' || evalId <= 0) continue;
    const item: InFlightEval = {
      exec,
      evalId,
      binding: typeof entry['binding'] === 'string' ? entry['binding'] : null,
      workspace: typeof entry['workspace'] === 'string' ? entry['workspace'] : '',
      async: entry['async'] === true,
      startedAt: numberOrZero(entry['startedAt']),
      ageMs: numberOrZero(entry['ageMs']),
    };
    if (typeof entry['timeoutMs'] === 'number' && Number.isFinite(entry['timeoutMs'])) {
      item.timeoutMs = entry['timeoutMs'];
    }
    items.push(item);
  }
  return { total: numberOrZero(value['total']), items };
}

function normalizeBindings(value: unknown): BindingActivity[] {
  if (!Array.isArray(value)) return [];
  const bindings: BindingActivity[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    bindings.push({
      binding: typeof entry['binding'] === 'string' ? entry['binding'] : null,
      label: typeof entry['label'] === 'string' ? entry['label'] : null,
      execSessions: numberOrZero(entry['execSessions']),
      inFlightEvals: numberOrZero(entry['inFlightEvals']),
      inFlightCalls: numberOrZero(entry['inFlightCalls']),
      queuedCalls: numberOrZero(entry['queuedCalls']),
    });
  }
  return bindings;
}

function normalizeResources(value: unknown): ResourceSnapshot | null {
  if (!isRecord(value)) return null;
  const rawSeries = Array.isArray(value['series']) ? value['series'] : [];
  const series: ResourceSample[] = [];
  for (const entry of rawSeries) {
    const sample = normalizeResourceSample(entry);
    if (sample !== null) series.push(sample);
  }
  const current =
    normalizeResourceSample(value['current']) ??
    (series.length === 0 ? null : series[series.length - 1] ?? null);
  return {
    current,
    series,
    intervalMs: numberOrZero(value['intervalMs']),
  };
}

function normalizeResourceSample(value: unknown): ResourceSample | null {
  if (!isRecord(value)) return null;
  return {
    ts: numberOrZero(value['ts']),
    selfRssBytes: numberOrZero(value['selfRssBytes']),
    childRssBytes: numberOrZero(value['childRssBytes']),
    childCount: numberOrZero(value['childCount']),
    totalRssBytes: numberOrZero(value['totalRssBytes']),
    selfCpuPercent: numberOrZero(value['selfCpuPercent']),
    childCpuPercent: numberOrZero(value['childCpuPercent']),
    totalCpuPercent: numberOrZero(value['totalCpuPercent']),
  };
}

function normalizeSettings(value: unknown): RuntimeSettings {
  const record = isRecord(value) ? value : {};
  const raw = isRecord(record['settings']) ? record['settings'] : {};
  const strictAuth =
    typeof raw['strictAuth'] === 'boolean' ? raw['strictAuth'] : undefined;
  return {
    capacity: finiteNumbers(raw['capacity']),
    ...(strictAuth === undefined ? {} : { strictAuth }),
  };
}

function normalizeServers(value: unknown): ServerView[] | null {
  if (!isRecord(value) || !Array.isArray(value['servers'])) return null;
  const servers: ServerView[] = [];
  for (const entry of value['servers']) {
    if (!isRecord(entry)) continue;
    const id = typeof entry['id'] === 'string' ? entry['id'] : '';
    if (id === '') continue;
    const transport = typeof entry['transport'] === 'string' ? entry['transport'] : undefined;
    const label = typeof entry['label'] === 'string' ? entry['label'] : id;
    const state = typeof entry['state'] === 'string' ? entry['state'] : 'unknown';
    const lastError =
      typeof entry['lastError'] === 'string' && entry['lastError'] !== ''
        ? entry['lastError']
        : undefined;
    servers.push({
      id,
      label,
      enabled: entry['enabled'] === true,
      state,
      ...(transport === undefined ? {} : { transport }),
      ...(lastError === undefined ? {} : { lastError }),
    });
  }
  return servers;
}

function isBuiltinServer(server: { id: string; transport?: string }): boolean {
  return server.transport === 'builtin' || BUILTIN_SERVER_IDS.has(server.id);
}

function countClients(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value['clients'])) return null;
  return value['clients'].length;
}

function normalizeAlerts(value: unknown): AlertConfig | null {
  if (!isRecord(value) || typeof value['enabled'] !== 'boolean') return null;
  const webhook = value['webhook'];
  return {
    enabled: value['enabled'],
    webhookConfigured: isRecord(webhook) && webhook['configured'] === true,
  };
}

function normalizeOpenReports(value: unknown): { count: number; hasMore: boolean } | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  const cursor = value['nextCursor'];
  return {
    count: value['items'].length,
    hasMore: typeof cursor === 'string' && cursor !== '',
  };
}

function countPendingAnnotations(value: unknown): number | null {
  if (!isRecord(value) || !Array.isArray(value['items'])) return null;
  return value['items'].length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function settledValue<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === 'fulfilled' ? result.value : null;
}

function settledProblem(result: PromiseSettledResult<unknown>): string {
  return result.status === 'rejected' ? `读取失败：${failureText(result.reason)}` : '返回格式异常';
}

function failureText(error: unknown): string {
  return error instanceof ApiError ? `${error.message}（${error.code}）` : String(error);
}
