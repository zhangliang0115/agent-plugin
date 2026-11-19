/** Problem-report page: create reports, filter the list, inspect details and track alert
 * delivery (design 06 §6).
 *
 * Reports are operational data, so the page lives under 监控 next to 概览/审计; the alert
 * webhook and severity threshold stay in 系统管理 › 配置 › 告警. The list polls
 * `/admin/api/reports` every 30 seconds while visible. Report detail and context are shown
 * in the shared drawer; status changes and alert retries go through the same typed client.
 * @module
 */

import { ApiError } from '../lib/api.ts';
import { formatId, formatJson, formatNumber, formatTimestamp } from '../lib/format.ts';
import {
  add,
  badge,
  button,
  cardSection,
  clippedCell,
  createDrawer,
  definitionList,
  describeError,
  el,
  emptyBlock,
  emptyState,
  failureText,
  field,
  formError,
  input,
  loading,
  notice,
  pageFrame,
  selectControl,
  setFormError,
  setStyle,
  startPolling,
  tablePanel,
  td,
  textarea,
  toast,
  type PageContext,
  type PageHandle,
} from './shared.ts';

type Severity = 'low' | 'medium' | 'high' | 'critical';
type ReportStatus = 'open' | 'ack' | 'closed';
type ReportSource = 'mcp' | 'admin';
type AlertState = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped' | 'no_webhook';

interface ReportView {
  id: string;
  createdAt: string;
  updatedAt: string;
  source: ReportSource;
  binding: string | null;
  client: string | null;
  mcp: string | null;
  exec: string | null;
  evalId: string | null;
  severity: Severity;
  title: string;
  status: ReportStatus;
  alertState: AlertState;
  alertError: string | null;
  alertAttempts: number;
  alertUpdatedAt: string | null;
  alertedAt: string | null;
  detail?: string;
  context?: unknown;
}

interface ReportsResponse {
  items: ReportView[];
  nextCursor: string | null;
}

const SEVERITY_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'low', label: 'low' },
  { value: 'medium', label: 'medium' },
  { value: 'high', label: 'high' },
  { value: 'critical', label: 'critical' },
];

const REPORT_STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'open', label: 'open' },
  { value: 'ack', label: 'ack' },
  { value: 'closed', label: 'closed' },
];

const REPORT_SEVERITY_FILTER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: '全部严重级' },
  ...SEVERITY_OPTIONS,
];

function severityTone(severity: Severity): 'error' | 'queue' | 'info' | 'neutral' {
  if (severity === 'critical') return 'error';
  if (severity === 'high') return 'queue';
  if (severity === 'medium') return 'info';
  return 'neutral';
}

function reportStatusTone(status: ReportStatus): 'ok' | 'queue' | 'info' {
  if (status === 'closed') return 'ok';
  if (status === 'ack') return 'queue';
  return 'info';
}

function alertStateBadge(state: AlertState): HTMLSpanElement {
  const tone =
    state === 'sent'
      ? 'ok'
      : state === 'failed' || state === 'no_webhook'
        ? 'error'
        : state === 'skipped'
          ? 'queue'
          : state === 'pending' || state === 'sending'
            ? 'info'
            : 'neutral';
  return badge(state, tone);
}

export function createReportsPage(context: PageContext): PageHandle {
  const { section, body } = pageFrame(
    '报告',
    '问题报告列表与告警投递状态。报告正文与 context 不进入告警消息；告警配置在“配置 › 告警”。',
  );

  const state = {
    reports: [] as ReportView[],
    cursor: null as string | null,
    loaded: false,
    status: '' as '' | ReportStatus,
    severity: '' as '' | Severity,
  };

  const drawer = createDrawer();
  const controller = new AbortController();
  let destroyed = false;
  let reportHost: HTMLElement | null = null;
  let statusHost: HTMLElement | null = null;
  let polling: ReturnType<typeof startPolling> | null = null;

  async function load(reset: boolean): Promise<void> {
    if (!reset && state.cursor === null) return;
    const query: Record<string, string | number> = { limit: 50 };
    if (state.status !== '') query['status'] = state.status;
    if (state.severity !== '') query['severity'] = state.severity;
    if (!reset && state.cursor !== null) query['cursor'] = state.cursor;
    const response = await context.api.get<ReportsResponse>('/reports', {
      query,
      signal: controller.signal,
    });
    if (destroyed) return;
    const items = Array.isArray(response.items) ? response.items : [];
    state.reports = reset ? items : [...state.reports, ...items];
    state.cursor = typeof response.nextCursor === 'string' ? response.nextCursor : null;
    state.loaded = true;
  }

  function showStatus(message: string, tone: 'error' | 'queue'): void {
    if (statusHost === null) {
      toast(message, tone === 'error' ? 'error' : 'queue');
      return;
    }
    statusHost.replaceChildren(notice(message, tone));
  }

  async function reload(): Promise<void> {
    try {
      await load(true);
      if (!destroyed && reportHost !== null) {
        renderReports(reportHost);
        statusHost?.replaceChildren();
      }
    } catch (error) {
      if (!destroyed) showStatus(failureText(error), 'error');
    }
  }

  function startPollingReports(): void {
    if (polling !== null) return;
    polling = startPolling(async () => {
      if (destroyed) return;
      await load(true);
      if (!destroyed && reportHost !== null && reportHost.isConnected) renderReports(reportHost);
    }, 30_000);
  }

  function buildToolbar(): HTMLElement {
    const fragment = el('div');
    setStyle(fragment, { display: 'flex', flexDirection: 'column', gap: '20px' });

    fragment.append(buildCreateCard());

    const statusFilter = selectControl(REPORT_STATUS_OPTIONS, {
      value: state.status,
      ariaLabel: '报告状态过滤',
      onChange: (value) => {
        state.status = value as '' | ReportStatus;
        void reload();
      },
    });
    const severityFilter = selectControl(REPORT_SEVERITY_FILTER_OPTIONS, {
      value: state.severity,
      ariaLabel: '报告严重级过滤',
      onChange: (value) => {
        state.severity = value as '' | Severity;
        void reload();
      },
    });
    const listCard = cardSection({
      title: '问题报告',
      subtitle: `${formatNumber(state.reports.length)} 条 · 每 30 秒刷新（页面隐藏时暂停）`,
      icon: 'alert',
      flush: true,
      actions: [
        statusFilter,
        severityFilter,
        button('刷新', () => void reload(), { variant: 'secondary', icon: 'refresh' }),
      ],
    });
    statusHost = el('div');
    listCard.body.appendChild(statusHost);
    reportHost = el('div');
    listCard.body.appendChild(reportHost);
    renderReports(reportHost);
    fragment.append(listCard.element);
    startPollingReports();
    return fragment;
  }

  function buildCreateCard(): HTMLElement {
    const handle = cardSection({
      title: '新建问题报告',
      subtitle: '提交后写入数据库并进入告警队列；用于联调与手工记录。',
      icon: 'plus',
    });
    const formBody = el('div');
    setStyle(formBody, { display: 'flex', flexDirection: 'column', gap: '12px' });
    formBody.hidden = true;
    // `.card-body` has its own padding; hide it too so a collapsed card stays compact.
    handle.body.hidden = true;
    const toggle = button('展开表单', () => {
      formBody.hidden = !formBody.hidden;
      handle.body.hidden = formBody.hidden;
      toggle.textContent = formBody.hidden ? '展开表单' : '收起表单';
    }, { variant: 'secondary', icon: 'chevron-down' });
    handle.actions.appendChild(toggle);

    const title = input({ placeholder: 'Bash 执行 npm test 时挂起' });
    title.maxLength = 200;
    const detail = textarea({ rows: 6, placeholder: '现象、期望与实际、复现步骤；不要粘贴密钥。' });
    detail.maxLength = 20_000;
    const severity = selectControl(SEVERITY_OPTIONS, { value: 'high', ariaLabel: 'severity' });
    const contextArea = textarea({
      rows: 4,
      placeholder: '可选 JSON 对象，≤ 8192 字节；例如 {"tool":"Bash"}',
    });
    const errorLine = formError();
    const submit = button('提交报告', () => undefined, { type: 'submit', variant: 'primary' });
    const form = el('form');
    form.noValidate = true;
    setStyle(form, { display: 'flex', flexDirection: 'column', gap: '12px' });
    add(
      form,
      notice('报告中不要粘贴密钥；详情与 context 不会进入告警消息和审计日志。', 'queue'),
      field('标题', title),
      field('详情', detail),
      field('严重级', severity),
      field('context（JSON）', contextArea),
      errorLine,
      submit,
    );
    formBody.appendChild(form);
    handle.body.appendChild(formBody);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      setFormError(errorLine, null);
      const titleText = title.value.trim();
      const detailText = detail.value.trim();
      if (titleText === '') {
        setFormError(errorLine, '标题不能为空。');
        return;
      }
      if (detailText === '') {
        setFormError(errorLine, '详情不能为空。');
        return;
      }
      let parsedContext: unknown;
      if (contextArea.value.trim() !== '') {
        try {
          parsedContext = JSON.parse(contextArea.value);
        } catch (error) {
          setFormError(errorLine, `context JSON 解析失败：${describeError(error)}`);
          return;
        }
        if (
          typeof parsedContext !== 'object' ||
          parsedContext === null ||
          Array.isArray(parsedContext)
        ) {
          setFormError(errorLine, 'context 必须是 JSON 对象。');
          return;
        }
      }
      const body: Record<string, unknown> = {
        title: titleText,
        detail: detailText,
        severity: severity.value,
      };
      if (parsedContext !== undefined) body['context'] = parsedContext;
      submit.disabled = true;
      submit.textContent = '提交中…';
      void context.api
        .post<{ report: ReportView }>('/reports', body, { signal: controller.signal })
        .then(async (response) => {
          if (destroyed) return;
          toast(`已创建报告 ${response.report.id}；状态 ${response.report.status}。`, 'ok');
          title.value = '';
          detail.value = '';
          contextArea.value = '';
          try {
            await load(true);
            if (!destroyed && reportHost !== null) renderReports(reportHost);
          } catch (refreshError) {
            if (!destroyed) showStatus(`报告已创建，但刷新列表失败：${failureText(refreshError)}`, 'queue');
          }
        })
        .catch((error: unknown) => {
          if (!destroyed) setFormError(errorLine, failureText(error));
        })
        .finally(() => {
          if (submit.isConnected) {
            submit.disabled = false;
            submit.textContent = '提交报告';
          }
        });
    });
    return handle.element;
  }

  function renderReports(host: HTMLElement): void {
    host.replaceChildren();
    if (state.reports.length === 0) {
      host.appendChild(
        emptyBlock('还没有问题报告。', '可以在上方新建报告，或让 MCP 客户端调用 report_problem。'),
      );
      return;
    }
    const table = el('table');
    const thead = el('thead');
    const head = el('tr');
    for (const label of ['时间', '严重级', '标题', '来源', '状态', '告警状态']) {
      add(head, el('th', '', label));
    }
    thead.appendChild(head);
    const tbody = el('tbody');
    for (const report of state.reports) {
      const row = el('tr');
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => openDetail(report.id));
      const time = el('span', '', formatTimestamp(report.createdAt));
      time.title = report.createdAt;
      add(
        row,
        td(time),
        td(badge(report.severity, severityTone(report.severity))),
        clippedCell(report.title, 380),
        td(badge(report.source, report.source === 'mcp' ? 'info' : 'neutral')),
        td(badge(report.status, reportStatusTone(report.status))),
        td(alertStateBadge(report.alertState)),
      );
      tbody.appendChild(row);
    }
    add(table, thead, tbody);
    host.appendChild(tablePanel(table));
    if (state.cursor !== null) {
      const footer = el('div', 'toolbar');
      add(
        footer,
        button('加载更多', () => {
          void load(false)
            .then(() => {
              if (!destroyed && reportHost !== null) renderReports(reportHost);
            })
            .catch((error: unknown) => {
              if (error instanceof ApiError && error.code === 'INVALID_CURSOR') {
                state.cursor = null;
                void reload();
                showStatus('分页游标失效，已从头加载。', 'queue');
                return;
              }
              if (!destroyed) showStatus(failureText(error), 'error');
            });
        }, { variant: 'secondary' }),
      );
      setStyle(footer, { padding: '12px 16px' });
      host.appendChild(footer);
    }
  }

  function openDetail(reportId: string): void {
    drawer.open(`报告 ${formatId(reportId, 20)}`, loading('正在加载报告详情…'));
    void context.api
      .get<{ report: ReportView }>(`/reports/${encodeURIComponent(reportId)}`, {
        signal: controller.signal,
      })
      .then((response) => {
        if (destroyed) return;
        drawer.open(`报告 ${formatId(reportId, 20)}`, buildDetail(response.report));
      })
      .catch((error: unknown) => {
        if (destroyed) return;
        const box = el('div');
        add(box, notice(failureText(error), 'error'));
        drawer.open(`报告 ${formatId(reportId, 20)}`, box);
      });
  }

  function buildDetail(report: ReportView): HTMLElement {
    const wrapper = el('div');
    setStyle(wrapper, { display: 'flex', flexDirection: 'column', gap: '16px' });
    const head = el('div', 'toolbar');
    add(
      head,
      badge(report.severity, severityTone(report.severity)),
      badge(report.status, reportStatusTone(report.status)),
      alertStateBadge(report.alertState),
      badge(report.source, report.source === 'mcp' ? 'info' : 'neutral'),
    );
    add(wrapper, head);
    add(
      wrapper,
      definitionList([
        { label: 'id', value: report.id, mono: true },
        { label: '创建', value: formatTimestamp(report.createdAt) },
        { label: '更新', value: formatTimestamp(report.updatedAt) },
        { label: '来源', value: report.source },
        { label: 'binding', value: report.binding ?? '—', mono: true },
        { label: 'client', value: report.client ?? '—', mono: true },
        { label: 'mcp', value: report.mcp ?? '—', mono: true },
        { label: 'exec', value: report.exec ?? '—', mono: true },
        { label: 'evalId', value: report.evalId ?? '—', mono: true },
        { label: '告警尝试', value: formatNumber(report.alertAttempts) },
        { label: '告警错误', value: report.alertError ?? '—', mono: true },
        { label: '告警更新', value: formatTimestamp(report.alertUpdatedAt) },
        { label: '送达时间', value: formatTimestamp(report.alertedAt) },
      ]),
    );

    add(wrapper, el('h3', '', report.title));
    const detail = el('pre', '', report.detail ?? '');
    setStyle(detail, {
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      margin: '0',
      fontFamily: 'inherit',
      fontSize: '13px',
    });
    add(wrapper, detail);

    if (report.context !== undefined && report.context !== null) {
      add(wrapper, el('h3', '', 'context'));
      const context = el('pre', '', formatJson(report.context, 2));
      setStyle(context, {
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        margin: '0',
        padding: '12px',
        border: '1px solid var(--border)',
        borderRadius: '8px',
      });
      add(wrapper, context);
    }

    if (report.alertError !== null) add(wrapper, notice(report.alertError, 'error'));

    const actions = el('div', 'toolbar');
    if (report.status === 'open') {
      actions.appendChild(
        button('确认', () => void changeStatus(report.id, 'ack'), {
          variant: 'secondary',
          size: 'sm',
        }),
      );
    }
    if (report.status !== 'open') {
      actions.appendChild(
        button('重新打开', () => void changeStatus(report.id, 'open'), {
          variant: 'secondary',
          size: 'sm',
        }),
      );
    }
    if (report.status !== 'closed') {
      actions.appendChild(
        button('关闭', () => void changeStatus(report.id, 'closed'), {
          variant: 'primary',
          size: 'sm',
        }),
      );
    }
    if (
      report.alertState === 'failed' ||
      report.alertState === 'skipped' ||
      report.alertState === 'no_webhook'
    ) {
      actions.appendChild(
        button('重发告警', () => void retryAlert(report.id), {
          variant: 'secondary',
          size: 'sm',
        }),
      );
    }
    actions.appendChild(button('关闭详情', () => drawer.close(), { variant: 'ghost', size: 'sm' }));
    add(wrapper, actions);
    return wrapper;
  }

  async function changeStatus(reportId: string, status: ReportStatus): Promise<void> {
    try {
      await context.api.patch<{ report: ReportView }>(
        `/reports/${encodeURIComponent(reportId)}`,
        { status },
        { signal: controller.signal },
      );
      if (destroyed) return;
      toast(`报告状态已更新为 ${status}。`, 'ok');
      await reload();
      openDetail(reportId);
    } catch (error) {
      if (!destroyed) showStatus(failureText(error), 'error');
    }
  }

  async function retryAlert(reportId: string): Promise<void> {
    try {
      await context.api.post<{ report: ReportView }>(
        `/reports/${encodeURIComponent(reportId)}/retry-alert`,
        undefined,
        { signal: controller.signal },
      );
      if (destroyed) return;
      toast('告警已重新排队。', 'ok');
      await reload();
      openDetail(reportId);
    } catch (error) {
      if (!destroyed) showStatus(failureText(error), 'error');
    }
  }

  const initialHost = el('div');
  add(body, initialHost);

  function mount(): void {
    initialHost.replaceChildren(loading('正在加载报告…'));
    void load(true)
      .then(() => {
        if (destroyed) return;
        initialHost.replaceChildren(buildToolbar());
      })
      .catch((error: unknown) => {
        if (destroyed) return;
        initialHost.replaceChildren(
          emptyState('报告加载失败', failureText(error)),
          button('重试', mount, { variant: 'primary', icon: 'refresh' }),
        );
      });
  }
  mount();

  return {
    element: section,
    destroy() {
      destroyed = true;
      polling?.stop();
      controller.abort();
      drawer.close();
    },
  };
}
