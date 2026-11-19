/** Shared management UX components: error hints, field messages and disclosure behaviour.
 *
 * No jsdom: the page modules are plain DOM functions, so this file installs a tiny
 * in-memory DOM stub (elements, text nodes, attributes and click listeners) and drives
 * the components directly. `statusDetail` and `templateCard` use native `<button>`
 * elements, which is where their Enter/Space keyboard behaviour comes from; the tests
 * assert that semantic instead of re-implementing browser activation.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  errorActionHint,
  field,
  inlineProgress,
  sectionGroup,
  statusDetail,
  tabIntro,
  templateCard,
} from '../src/pages/shared.ts';

// ---------------------------------------------------------------------------
// Minimal DOM stub
// ---------------------------------------------------------------------------

interface StubEvent {
  type: string;
  target: StubElement | null;
  defaultPrevented: boolean;
  preventDefault(): void;
}

type Listener = (event: StubEvent) => void;

class StubNode {
  nodeType = 1;
  parentNode: StubNode | null = null;
  childNodes: StubNode[] = [];

  get firstElementChild(): StubElement | null {
    for (const child of this.childNodes) {
      if (child instanceof StubElement) return child;
    }
    return null;
  }

  get childElementCount(): number {
    return this.childNodes.filter((child) => child instanceof StubElement).length;
  }

  appendChild<T extends StubNode>(node: T): T {
    if (node.parentNode !== null) node.parentNode.removeChild(node);
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  removeChild<T extends StubNode>(node: T): T {
    const index = this.childNodes.indexOf(node);
    if (index >= 0) this.childNodes.splice(index, 1);
    node.parentNode = null;
    return node;
  }

  remove(): void {
    this.parentNode?.removeChild(this);
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (value !== '') this.appendChild(new StubText(value));
  }
}

class StubText extends StubNode {
  data: string;

  constructor(data: string) {
    super();
    this.nodeType = 3;
    this.data = data;
  }

  get textContent(): string {
    return this.data;
  }

  set textContent(value: string) {
    this.data = String(value);
  }
}

class StubClassList {
  element: StubElement;

  constructor(element: StubElement) {
    this.element = element;
  }

  contains(token: string): boolean {
    return this.tokens().includes(token);
  }

  add(...tokens: string[]): void {
    const current = this.tokens();
    for (const token of tokens) {
      if (!current.includes(token)) current.push(token);
    }
    this.write(current);
  }

  remove(...tokens: string[]): void {
    this.write(this.tokens().filter((token) => !tokens.includes(token)));
  }

  toggle(token: string, force?: boolean): boolean {
    const has = this.contains(token);
    const next = force === undefined ? !has : force;
    if (next && !has) this.add(token);
    if (!next && has) this.remove(token);
    return next;
  }

  tokens(): string[] {
    return this.element.className.split(/\s+/).filter((token) => token !== '');
  }

  write(tokens: string[]): void {
    this.element.className = tokens.join(' ');
  }
}

class StubElement extends StubNode {
  tagName: string;
  className = '';
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  listeners = new Map<string, Listener[]>();
  classList: StubClassList;
  hidden = false;
  id = '';
  type = '';
  title = '';
  disabled = false;
  tabIndex = 0;
  innerHTML = '';

  constructor(tagName: string) {
    super();
    this.tagName = tagName.toUpperCase();
    this.classList = new StubClassList(this);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  addEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: Listener): void {
    const bucket = this.listeners.get(type);
    if (bucket === undefined) return;
    this.listeners.set(
      type,
      bucket.filter((entry) => entry !== listener),
    );
  }

  dispatchEvent(event: StubEvent): boolean {
    event.target = this;
    for (const listener of this.listeners.get(event.type) ?? []) listener(event);
    return !event.defaultPrevented;
  }

  click(): void {
    this.dispatchEvent(createEvent('click'));
  }

  prepend(...nodes: Array<StubNode | string>): void {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const raw = nodes[index];
      if (raw === undefined) continue;
      const node = typeof raw === 'string' ? new StubText(raw) : raw;
      if (node.parentNode !== null) node.parentNode.removeChild(node);
      node.parentNode = this;
      this.childNodes.unshift(node);
    }
  }
}

function createEvent(type: string): StubEvent {
  return {
    type,
    target: null,
    defaultPrevented: false,
    preventDefault(): void {
      this.defaultPrevented = true;
    },
  };
}

const stubDocument = {
  body: new StubElement('body'),
  documentElement: new StubElement('html'),
  visibilityState: 'visible',
  createElement(tagName: string): StubElement {
    return new StubElement(tagName);
  },
  createElementNS(_namespace: string, tagName: string): StubElement {
    return new StubElement(tagName);
  },
  createTextNode(text: string): StubText {
    return new StubText(text);
  },
  querySelector(): null {
    return null;
  },
  querySelectorAll(): never[] {
    return [];
  },
  addEventListener(): void {},
  removeEventListener(): void {},
};

const scope = globalThis as unknown as Record<string, unknown>;
scope.document = stubDocument;
scope.window = { setTimeout, clearTimeout, confirm: () => true };
scope.Element = StubElement;
scope.HTMLElement = StubElement;
scope.SVGElement = StubElement;
scope.Node = StubNode;

function childElements(node: StubNode): StubElement[] {
  const result: StubElement[] = [];
  for (const child of node.childNodes) {
    if (child instanceof StubElement) result.push(child);
  }
  return result;
}

function byClass(node: StubNode, className: string): StubElement | null {
  for (const child of childElements(node)) {
    if (child.classList.contains(className)) return child;
    const nested = byClass(child, className);
    if (nested !== null) return nested;
  }
  return null;
}

function byTag(node: StubNode, tagName: string): StubElement | null {
  const wanted = tagName.toUpperCase();
  for (const child of childElements(node)) {
    if (child.tagName === wanted) return child;
    const nested = byTag(child, wanted);
    if (nested !== null) return nested;
  }
  return null;
}

function stub(node: unknown): StubElement {
  return node as StubElement;
}

// ---------------------------------------------------------------------------
// errorActionHint
// ---------------------------------------------------------------------------

const CONFLICT_HINT = '配置已在别处修改，请刷新后重试。';
const DEFAULT_HINT = '请查看详情后重试。';

test('errorActionHint maps known server codes to Chinese next steps', () => {
  assert.equal(
    errorActionHint('CAPACITY_EXCEEDED'),
    '并发容量已满，请等待运行中的任务结束后重试。',
  );
  assert.equal(errorActionHint('WS_LIMIT'), '工作区数量已达上限，请先移除不再使用的工作区。');
  assert.equal(errorActionHint('WS_INVALID'), '工作区路径不可用，请检查路径是否存在且可访问。');
  assert.equal(
    errorActionHint('MCP_SERVER_UNAVAILABLE'),
    'MCP server 当前不可用，请检查进程状态后重试。',
  );
  assert.equal(errorActionHint('MCP_QUEUE_FULL'), '该 server 的调用队列已满，请稍后重试。');
  assert.equal(
    errorActionHint('MCP_CALL_TIMEOUT'),
    'MCP 调用超时，请检查 server 状态或调大 timeoutMs 后重试。',
  );
  assert.equal(errorActionHint('EXCLUSIVE_TIMEOUT'), '等待独占调用超时，请稍后重试。');
  assert.equal(
    errorActionHint('AI_RUNNER_UNAVAILABLE'),
    'AI 服务不可用，请确认 AI 配置与运行环境后重试。',
  );
});

test('errorActionHint covers the DISCOVERY family', () => {
  assert.equal(errorActionHint('DISCOVERY_BUSY'), '已有扫描正在进行，请稍后重试。');
  assert.equal(
    errorActionHint('DISCOVERY_EMPTY_PREVIEW'),
    '预览结果为空，请调整查询条件后重新预览。',
  );
  assert.equal(
    errorActionHint('DISCOVERY_PARTIAL_STALE_UNCONFIRMED'),
    '预览不完整，请重新预览并确认。',
  );
  assert.equal(
    errorActionHint('DISCOVERY_TIMEOUT'),
    '工具发现失败，请检查查询条件后重新扫描。',
  );
});

test('errorActionHint treats 409 and conflict codes as a revision conflict', () => {
  assert.equal(errorActionHint('409'), CONFLICT_HINT);
  assert.equal(errorActionHint('CONFLICT'), CONFLICT_HINT);
  assert.equal(errorActionHint('REVISION_CONFLICT'), CONFLICT_HINT);
});

test('errorActionHint falls back for unknown codes and normalizes case', () => {
  assert.equal(errorActionHint(undefined), DEFAULT_HINT);
  assert.equal(errorActionHint('UNKNOWN_CODE'), DEFAULT_HINT);
  assert.equal(errorActionHint(undefined, '请稍后重试'), '请稍后重试');
  assert.equal(errorActionHint('UNKNOWN_CODE', '请稍后重试'), '请稍后重试');
  assert.equal(errorActionHint('  discovery_busy  '), '已有扫描正在进行，请稍后重试。');
});

// ---------------------------------------------------------------------------
// field
// ---------------------------------------------------------------------------

test('field renders hint and error text with aria wiring', () => {
  const control = stubDocument.createElement('input');
  const wrapper = field('server id', control, {
    hint: '小写字母与短横线',
    error: 'id 已存在',
  });

  assert.equal(wrapper.tagName, 'LABEL');
  assert.equal(wrapper.className, 'field');

  const hint = byClass(wrapper, 'field-hint');
  const message = byClass(wrapper, 'field-error');
  assert.ok(hint !== null);
  assert.ok(message !== null);
  assert.equal(hint.textContent, '小写字母与短横线');
  assert.equal(message.textContent, 'id 已存在');

  assert.equal(control.getAttribute('aria-invalid'), 'true');
  const describedBy = control.getAttribute('aria-describedby') ?? '';
  assert.ok(describedBy.includes(hint.id));
  assert.ok(describedBy.includes(message.id));
});

test('field keeps the legacy two-node shape without options', () => {
  const control = stubDocument.createElement('input');
  const wrapper = field('name', control);

  assert.equal(wrapper.childNodes.length, 2);
  assert.equal(byClass(wrapper, 'field-hint'), null);
  assert.equal(byClass(wrapper, 'field-error'), null);
  assert.equal(control.getAttribute('aria-invalid'), null);
  assert.equal(control.getAttribute('aria-describedby'), null);
});

test('field with only a hint does not mark the control invalid', () => {
  const control = stubDocument.createElement('input');
  const wrapper = field('timeout', control, { hint: '毫秒' });

  const hint = byClass(wrapper, 'field-hint');
  assert.ok(hint !== null);
  assert.equal(hint.textContent, '毫秒');
  assert.equal(control.getAttribute('aria-invalid'), null);
  assert.equal(control.getAttribute('aria-describedby'), hint.id);
});

// ---------------------------------------------------------------------------
// templateCard
// ---------------------------------------------------------------------------

test('templateCard is a native button that invokes onClick', () => {
  let clicks = 0;
  const card = templateCard({
    title: '添加 MCP server',
    description: '从 stdio 或 http 模板开始。',
    onClick: () => {
      clicks += 1;
    },
  });

  assert.equal(card.tagName, 'BUTTON');
  assert.equal(stub(card).type, 'button');
  assert.equal(byClass(card, 'template-card-title')?.textContent, '添加 MCP server');
  assert.equal(
    byClass(card, 'template-card-description')?.textContent,
    '从 stdio 或 http 模板开始。',
  );

  card.click();
  assert.equal(clicks, 1);
});

// ---------------------------------------------------------------------------
// statusDetail
// ---------------------------------------------------------------------------

test('statusDetail toggles diagnostics from a native button', () => {
  const node = statusDetail({
    label: '连接失败',
    tone: 'error',
    detail: 'lastError: ECONNREFUSED',
    lines: ['lastError: ECONNREFUSED', '上次刷新：10:24:05', '建议：检查 MCP server 进程'],
  });

  assert.equal(byClass(node, 'badge')?.textContent, '连接失败');
  assert.equal(byClass(node, 'status-detail-text')?.textContent, 'lastError: ECONNREFUSED');

  const toggle = byClass(node, 'status-detail-toggle');
  const panel = byClass(node, 'status-detail-lines');
  assert.ok(toggle !== null);
  assert.ok(panel !== null);
  assert.equal(toggle.tagName, 'BUTTON');
  assert.equal(toggle.type, 'button');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(toggle.getAttribute('aria-controls'), panel.id);
  assert.equal(panel.hidden, true);

  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(panel.hidden, false);

  const list = byTag(panel, 'ul');
  assert.ok(list !== null);
  assert.deepEqual(
    childElements(list).map((item) => item.textContent),
    ['lastError: ECONNREFUSED', '上次刷新：10:24:05', '建议：检查 MCP server 进程'],
  );

  toggle.click();
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  assert.equal(panel.hidden, true);
});

test('statusDetail without diagnostic lines is a static row', () => {
  const node = statusDetail({ label: 'ok', tone: 'ok', detail: '已连接' });
  assert.equal(byClass(node, 'status-detail-toggle'), null);
  assert.equal(byClass(node, 'status-detail-lines'), null);
  assert.equal(byClass(node, 'status-detail-text')?.textContent, '已连接');
});

// ---------------------------------------------------------------------------
// inlineProgress
// ---------------------------------------------------------------------------

test('inlineProgress reports state and shows retry only on error', () => {
  let retries = 0;
  const progress = inlineProgress({
    label: '重启 server',
    state: 'running',
    onRetry: () => {
      retries += 1;
    },
  });

  assert.equal(progress.element.getAttribute('aria-live'), 'polite');
  assert.equal(progress.element.dataset['state'], 'running');

  const retry = byClass(progress.element, 'inline-progress-retry');
  assert.ok(retry !== null);
  assert.equal(retry.hidden, true);
  assert.equal(byClass(progress.element, 'inline-progress-detail')?.hidden, true);

  progress.update('error', '重启失败：spawn ENOENT');
  assert.equal(progress.element.dataset['state'], 'error');
  assert.equal(
    byClass(progress.element, 'inline-progress-detail')?.textContent,
    '重启失败：spawn ENOENT',
  );
  assert.equal(retry.hidden, false);

  retry.click();
  assert.equal(retries, 1);

  progress.update('done');
  assert.equal(progress.element.dataset['state'], 'done');
  assert.equal(retry.hidden, true);
  assert.equal(
    byClass(progress.element, 'inline-progress-detail')?.textContent,
    '重启失败：spawn ENOENT',
  );
});

// ---------------------------------------------------------------------------
// sectionGroup and tabIntro
// ---------------------------------------------------------------------------

test('sectionGroup renders details/summary when collapsible', () => {
  const body = stubDocument.createElement('div');
  const group = sectionGroup({
    title: '连接配置',
    description: 'stdio 使用命令行，http 使用 url。',
    open: true,
    collapsible: true,
    body: [body],
  });

  assert.equal(group.tagName, 'DETAILS');
  assert.equal(stub(group).open, true);
  const summary = byTag(group, 'summary');
  assert.ok(summary !== null);
  assert.equal(byClass(summary, 'section-group-title')?.textContent, '连接配置');
  assert.equal(
    byClass(summary, 'section-group-description')?.textContent,
    'stdio 使用命令行，http 使用 url。',
  );
  const container = byClass(group, 'section-group-body');
  assert.ok(container !== null);
  assert.deepEqual(childElements(container), [body]);
});

test('sectionGroup renders a plain card group when not collapsible', () => {
  const body = stubDocument.createElement('div');
  const group = sectionGroup({ title: '元数据', body: [body] });

  assert.equal(group.tagName, 'SECTION');
  assert.equal(group.className, 'card section-group');
  assert.equal(byTag(group, 'summary'), null);
  assert.equal(byTag(group, 'h3')?.textContent, '元数据');
  assert.deepEqual(childElements(byClass(group, 'section-group-body') ?? group), [body]);
});

test('tabIntro renders a title, description and optional hint', () => {
  const intro = tabIntro({
    title: '服务器',
    description: '管理 MCP server 的进程、连接与配额。',
    hint: '修改连接配置后需要重启 server。',
  });

  assert.equal(byClass(intro, 'tab-intro-title')?.textContent, '服务器');
  assert.equal(
    byClass(intro, 'tab-intro-description')?.textContent,
    '管理 MCP server 的进程、连接与配额。',
  );
  const hint = byClass(intro, 'tab-intro-hint');
  assert.ok(hint !== null);
  assert.ok((hint.textContent ?? '').includes('修改连接配置后需要重启 server。'));

  const plain = tabIntro({ title: '工具', description: '查看工具目录。' });
  assert.equal(byClass(plain, 'tab-intro-hint'), null);
});
