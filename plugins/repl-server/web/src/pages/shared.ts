/** DOM and lifecycle helpers shared by the admin pages (`/overview`, `/audit`, `/manage`).
 *
 * Pages are plain DOM modules: each exports a factory that returns one section element
 * plus a `destroy` hook. The shell owns routing and replaces the section on navigation;
 * the page owns its timers, requests, listeners and drawer usage.
 *
 * Nothing here calls the server. Every request goes through the injected
 * {@link ApiClient}, which is the single typed transport described in 03 §4.1–4.3.
 * @module
 */

import { ApiError, type ApiClient } from '../lib/api.ts';
import { statusTone, type Tone } from '../lib/format.ts';
import type { RouteLocation } from '../lib/router.ts';

/** What the shell passes to a page factory. `location` is absent for ad-hoc mounts. */
export interface PageContext {
  api: ApiClient;
  location?: RouteLocation;
  /** Seed for pages that mirror filters into the hash; falls back to `location.query`. */
  query?: URLSearchParams;
  /** Hash navigation owned by the shell; pages only use it for optional deep links. */
  navigate?: (path: string, options?: { replace?: boolean }) => void;
}

/** The shell keeps the element and calls `destroy` when leaving the route. */
export interface PageHandle {
  readonly element: HTMLElement;
  destroy(): void;
}

/** Creates an element with an optional class list and text. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== '') element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Appends nodes and strings, ignoring `null`/`undefined` so callers can inline conditions. */
export function add(
  parent: Node,
  ...children: Array<Node | string | number | null | undefined>
): void {
  for (const child of children) {
    if (child === null || child === undefined) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? document.createTextNode(String(child))
        : child,
    );
  }
}

/** Assigns inline styles; used for layout that the shared stylesheet does not cover. */
export function setStyle(element: HTMLElement, styles: Partial<CSSStyleDeclaration>): void {
  Object.assign(element.style, styles);
}

export interface ButtonOptions {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  title?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  /** Compact height for dense toolbars and table rows. */
  size?: 'sm';
  /** Inline SVG name from {@link icon}; placed before the label. */
  icon?: string;
  ariaLabel?: string;
}

/** Creates a button wired to `onClick`; the default type never submits a surrounding form. */
export function button(
  label: string,
  onClick: (event: MouseEvent) => void,
  options: ButtonOptions = {},
): HTMLButtonElement {
  const classes = ['button'];
  if (options.variant !== undefined) classes.push(options.variant);
  if (options.size === 'sm') classes.push('sm');
  const control = el('button', classes.join(' '), label);
  control.type = options.type ?? 'button';
  if (options.title !== undefined) control.title = options.title;
  if (options.ariaLabel !== undefined) control.setAttribute('aria-label', options.ariaLabel);
  if (options.disabled === true) control.disabled = true;
  if (options.icon !== undefined) control.prepend(icon(options.icon, 14));
  control.addEventListener('click', onClick);
  return control;
}

/** Semantic pill used for states and statuses. */
export function badge(text: string, tone: Tone): HTMLSpanElement {
  return el('span', `badge tone-${tone}`, text);
}

export function statusBadge(status: string | boolean | null | undefined): HTMLSpanElement {
  if (typeof status === 'boolean') return badge(status ? 'ok' : 'error', statusTone(status));
  const text = status === null || status === undefined || status === '' ? '—' : status;
  return badge(text, statusTone(status));
}

// ---------------------------------------------------------------------------
// Design-system components
// ---------------------------------------------------------------------------

/** Canonical icon names understood by {@link icon} and {@link iconMarkup}. */
export type IconName =
  | 'overview'
  | 'audit'
  | 'manage'
  | 'refresh'
  | 'sun'
  | 'moon'
  | 'terminal'
  | 'close'
  | 'search'
  | 'chevron-down'
  | 'chevron-right'
  | 'chevron-left'
  | 'check'
  | 'check-circle'
  | 'alert'
  | 'info'
  | 'copy'
  | 'plus'
  | 'trash'
  | 'edit'
  | 'play'
  | 'server'
  | 'tool'
  | 'users'
  | 'key'
  | 'download'
  | 'upload'
  | 'external'
  | 'clock'
  | 'database'
  | 'filter'
  | 'inbox'
  | 'more'
  | 'menu'
  | 'arrow-right'
  | 'arrow-up-right'
  | 'activity'
  | 'layers'
  | 'shield'
  | 'dot';

/** 24×24 stroke glyphs; unknown names fall back to a dot so callers never render nothing. */
const ICON_PATHS: Readonly<Record<string, string>> = {
  overview:
    '<rect x="3" y="3" width="7" height="7" rx="1.6"/><rect x="14" y="3" width="7" height="7" rx="1.6"/><rect x="3" y="14" width="7" height="7" rx="1.6"/><rect x="14" y="14" width="7" height="7" rx="1.6"/>',
  audit:
    '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
  manage:
    '<path d="M4 7h7M15 7h5M4 17h3M11 17h9"/><circle cx="13" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.35 7.65"/><path d="M20 5v6h-6"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M19.07 4.93l-1.41 1.41M6.34 17.66l-1.41 1.41"/>',
  moon: '<path d="M21 13.2A8.5 8.5 0 0 1 10.8 3a8.5 8.5 0 1 0 10.2 10.2Z"/>',
  terminal: '<path d="M5 7l5 5-5 5"/><path d="M13 17h6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.2-3.2"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>',
  'chevron-right': '<path d="M9 6l6 6-6 6"/>',
  'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 6.5"/>',
  'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.5 2.5L16 9.5"/>',
  alert:
    '<path d="M12 3.5L21 19H3z"/><path d="M12 9.5v4"/><circle cx="12" cy="16.8" r=".6" fill="currentColor" stroke="none"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r=".6" fill="currentColor" stroke="none"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  play: '<path d="M8 5.5l11 6.5-11 6.5z"/>',
  server:
    '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  tool: '<path d="M14.5 6.5a4 4 0 0 0-5.2 5.2L4 17l3 3 5.3-5.3a4 4 0 0 0 5.2-5.2l-2.7 2.7-2.5-.5-.5-2.5z"/>',
  users:
    '<circle cx="9" cy="8" r="3.5"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.2a3.5 3.5 0 0 1 0 5.6M17.5 14.2A6 6 0 0 1 21 20"/>',
  key: '<circle cx="8" cy="8" r="4"/><path d="M11 11l9 9M17 17l2.5-2.5M14 14l2-2"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M4 20h16"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M4 4h16"/>',
  external:
    '<path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  database:
    '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6"/><path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
  inbox: '<path d="M4 5h16v10h-4l-2 3h-4l-2-3H4z"/><path d="M4 15v4h16v-4"/>',
  more: '<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  'arrow-right': '<path d="M4 12h16M14 6l6 6-6 6"/>',
  'arrow-up-right': '<path d="M7 17L17 7M8 7h9v9"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6z"/>',
  dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
};

/** Returns the icon as an SVG source string; use it inside template markup. */
export function iconMarkup(name: string, size = 16): string {
  const glyph = ICON_PATHS[name] ?? ICON_PATHS['dot'] ?? '';
  const dimension = Math.max(10, Math.min(64, Math.round(Number.isFinite(size) ? size : 16)));
  return `<svg class="icon" width="${dimension}" height="${dimension}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${glyph}</svg>`;
}

/** Returns a fresh inline SVG icon element; unknown names fall back to a dot. */
export function icon(name: string, size = 16): SVGSVGElement {
  const holder = document.createElement('span');
  holder.innerHTML = iconMarkup(name, size);
  const first = holder.firstElementChild;
  if (first instanceof SVGElement) return first as SVGSVGElement;
  const fallback = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  fallback.setAttribute('class', 'icon');
  fallback.setAttribute('viewBox', '0 0 24 24');
  return fallback;
}

/** Tone names accepted by the new components; legacy aliases are normalized before rendering. */
export type ComponentTone = Tone | 'success' | 'warning' | 'warn' | 'danger' | 'accent';

const TONE_ALIASES: Readonly<Record<string, Tone | 'accent'>> = {
  ok: 'ok',
  success: 'ok',
  error: 'error',
  failed: 'error',
  danger: 'error',
  queue: 'queue',
  warning: 'queue',
  warn: 'queue',
  slow: 'slow',
  info: 'info',
  neutral: 'neutral',
  accent: 'accent',
};

function canonicalTone(tone: string | undefined): Tone | 'accent' {
  if (tone === undefined) return 'neutral';
  return TONE_ALIASES[tone] ?? 'neutral';
}

export interface StatCardOptions {
  label: string;
  value: string | number;
  hint?: string;
  tone?: ComponentTone;
  icon?: string;
}

/** Metric tile: label, value, optional hint, tone and icon. */
export function statCard(options: StatCardOptions): HTMLElement;
export function statCard(
  label: string,
  value: string | number,
  hint?: string,
  tone?: ComponentTone,
  iconName?: string,
): HTMLElement;
export function statCard(
  labelOrOptions: string | StatCardOptions,
  value?: string | number,
  hint?: string,
  tone: ComponentTone = 'neutral',
  iconName?: string,
): HTMLElement {
  const options: StatCardOptions =
    typeof labelOrOptions === 'string'
      ? {
          label: labelOrOptions,
          value: value ?? '',
          ...(hint === undefined ? {} : { hint }),
          tone,
          ...(iconName === undefined ? {} : { icon: iconName }),
        }
      : labelOrOptions;
  const card = el('article', 'card stat-card');
  card.dataset['tone'] = canonicalTone(options.tone);
  const head = el('div', 'stat-head');
  add(head, el('p', 'eyebrow stat-label', options.label));
  if (options.icon !== undefined) add(head, icon(options.icon, 16));
  add(card, head, el('strong', 'stat-value', String(options.value)));
  if (options.hint !== undefined && options.hint !== '') {
    add(card, el('p', 'stat-hint', options.hint));
  }
  return card;
}

export interface CardSectionOptions {
  title?: string;
  subtitle?: string;
  icon?: string;
  actions?: Node | Node[];
  /** Removes body padding for tables that run to the card edge. */
  flush?: boolean;
  className?: string;
}

export interface CardSectionHandle {
  readonly element: HTMLElement;
  readonly section: HTMLElement;
  readonly body: HTMLElement;
  readonly actions: HTMLElement;
}

/** Card with a header/body split; the returned `body` is the content column. */
export function cardSection(
  titleOrOptions: string | CardSectionOptions = {},
  subtitle?: string,
): CardSectionHandle {
  const options: CardSectionOptions =
    typeof titleOrOptions === 'string'
      ? { title: titleOrOptions, ...(subtitle === undefined ? {} : { subtitle }) }
      : titleOrOptions;
  const classes = ['card', 'card-section'];
  if (options.className !== undefined && options.className !== '') classes.push(options.className);
  if (options.flush === true) classes.push('card-section-flush');
  const section = el('section', classes.join(' '));
  const body = el('div', 'card-body');
  const actions = el('div', 'card-actions');
  if (
    options.title !== undefined ||
    options.subtitle !== undefined ||
    options.actions !== undefined
  ) {
    const header = el('header', 'card-header');
    const heading = el('div', 'card-heading');
    if (options.icon !== undefined) add(heading, icon(options.icon, 18));
    const text = el('div', 'card-heading-text');
    if (options.title !== undefined) add(text, el('h2', 'card-title', options.title));
    if (options.subtitle !== undefined) add(text, el('p', 'card-subtitle', options.subtitle));
    add(heading, text, actions);
    add(header, heading);
    add(section, header);
  }
  add(section, body);
  if (options.actions !== undefined) {
    if (Array.isArray(options.actions)) {
      for (const action of options.actions) actions.appendChild(action);
    } else {
      actions.appendChild(options.actions);
    }
  }
  return { element: section, section, body, actions };
}

export interface SegmentOption {
  value: string;
  label: string;
  icon?: string;
  disabled?: boolean;
}

export interface SegmentedOptions {
  options: readonly SegmentOption[];
  value?: string;
  onChange?: (value: string) => void;
  ariaLabel?: string;
  size?: 'sm' | 'md';
}

/**
 * Segmented control. Accepts either an options object or `(entries, value, onChange)`;
 * the group manages its own pressed state and reports changes through `onChange`.
 */
export function segmented(
  entriesOrOptions: readonly SegmentOption[] | SegmentedOptions,
  selected?: string,
  onChange?: (value: string) => void,
): HTMLElement {
  const options: SegmentedOptions = Array.isArray(entriesOrOptions)
    ? {
        options: entriesOrOptions,
        ...(selected === undefined ? {} : { value: selected }),
        ...(onChange === undefined ? {} : { onChange }),
      }
    : (entriesOrOptions as SegmentedOptions);

  let current = options.value ?? options.options[0]?.value;
  const group = el('div', `segmented${options.size === 'sm' ? ' segmented-sm' : ''}`);
  group.setAttribute('role', 'group');
  if (options.ariaLabel !== undefined) group.setAttribute('aria-label', options.ariaLabel);
  const controls: HTMLButtonElement[] = [];

  for (const entry of options.options) {
    const control = el('button', 'segment', entry.label);
    control.type = 'button';
    control.dataset['value'] = entry.value;
    if (entry.icon !== undefined) control.prepend(icon(entry.icon, 14));
    if (entry.disabled === true) control.disabled = true;
    const active = entry.value === current;
    control.setAttribute('aria-pressed', String(active));
    if (active) control.classList.add('is-active');
    control.addEventListener('click', () => {
      if (current === entry.value) return;
      current = entry.value;
      for (const other of controls) {
        const pressed = other.dataset['value'] === current;
        other.setAttribute('aria-pressed', String(pressed));
        other.classList.toggle('is-active', pressed);
      }
      options.onChange?.(entry.value);
    });
    controls.push(control);
    group.appendChild(control);
  }
  return group;
}

export interface TabOption {
  id: string;
  label: string;
  icon?: string;
  badge?: string | number;
}

export interface TabsOptions {
  ariaLabel?: string;
  className?: string;
}

/** Underline tabs; the returned nav updates `aria-selected` before `onChange` runs. */
export function tabs(
  entries: readonly TabOption[],
  activeId: string,
  onChange: (id: string) => void,
  options: TabsOptions = {},
): HTMLElement {
  const nav = el('nav', `tabs${options.className === undefined ? '' : ` ${options.className}`}`);
  nav.setAttribute('role', 'tablist');
  if (options.ariaLabel !== undefined) nav.setAttribute('aria-label', options.ariaLabel);
  const controls = new Map<string, HTMLButtonElement>();

  for (const entry of entries) {
    const control = el('button', 'tab');
    control.type = 'button';
    control.setAttribute('role', 'tab');
    control.dataset['tab'] = entry.id;
    if (entry.icon !== undefined) control.appendChild(icon(entry.icon, 14));
    control.appendChild(el('span', 'tab-label', entry.label));
    if (entry.badge !== undefined) control.appendChild(el('span', 'tab-badge', String(entry.badge)));
    controls.set(entry.id, control);
    nav.appendChild(control);
  }

  function mark(id: string): void {
    for (const [key, control] of controls) {
      const selected = key === id;
      control.setAttribute('aria-selected', String(selected));
      control.classList.toggle('is-active', selected);
      control.tabIndex = selected ? 0 : -1;
    }
  }
  mark(activeId);

  nav.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const control = target.closest<HTMLButtonElement>('[data-tab]');
    if (control === null || control.disabled) return;
    const id = control.dataset['tab'];
    if (id === undefined || id === activeId) return;
    activeId = id;
    mark(id);
    onChange(id);
  });
  return nav;
}

export interface SelectEntry {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectControlOptions {
  value?: string;
  name?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
  ariaLabel?: string;
  size?: 'sm' | 'md';
}

/**
 * Styled `<select>` with the custom chevron. Accepts `(entries, value, onChange)` or
 * `(entries, { value, onChange, … })`; the first entry is selected when no value matches.
 */
export function selectControl(
  entries: readonly SelectEntry[],
  valueOrOptions: string | SelectControlOptions = {},
  onChange?: (value: string) => void,
): HTMLSelectElement {
  const options: SelectControlOptions =
    typeof valueOrOptions === 'string'
      ? { value: valueOrOptions, ...(onChange === undefined ? {} : { onChange }) }
      : valueOrOptions;
  const control = el('select', `select${options.size === 'sm' ? ' select-sm' : ''}`);
  if (options.name !== undefined) control.name = options.name;
  if (options.disabled === true) control.disabled = true;
  if (options.ariaLabel !== undefined) control.setAttribute('aria-label', options.ariaLabel);
  for (const entry of entries) {
    const option = el('option', '', entry.label);
    option.value = entry.value;
    if (entry.disabled === true) option.disabled = true;
    control.appendChild(option);
  }
  const desired = options.value;
  if (desired !== undefined && entries.some((entry) => entry.value === desired)) {
    control.value = desired;
  } else if (entries.length > 0) {
    control.value = entries[0]?.value ?? '';
  }
  if (options.onChange !== undefined) {
    const listener = options.onChange;
    control.addEventListener('change', () => listener(control.value));
  }
  return control;
}

export interface TextInputOptions extends InputOptions {
  onInput?: (value: string) => void;
  onChange?: (value: string) => void;
  ariaLabel?: string;
  autocomplete?: string;
  spellcheck?: boolean;
}

/** Text-like input with the shared `.input` styling and change/input callbacks. */
export function textInput(options: TextInputOptions = {}): HTMLInputElement {
  const control = input(options);
  control.classList.add('input');
  if (options.ariaLabel !== undefined) control.setAttribute('aria-label', options.ariaLabel);
  if (options.autocomplete !== undefined) control.setAttribute('autocomplete', options.autocomplete);
  if (options.spellcheck !== undefined) control.spellcheck = options.spellcheck;
  if (options.onInput !== undefined) {
    const listener = options.onInput;
    control.addEventListener('input', () => listener(control.value));
  }
  if (options.onChange !== undefined) {
    const listener = options.onChange;
    control.addEventListener('change', () => listener(control.value));
  }
  return control;
}

export interface SwitchControlOptions {
  checked?: boolean;
  label?: string;
  name?: string;
  id?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onChange?: (checked: boolean) => void;
}

export interface SwitchControlElement extends HTMLLabelElement {
  readonly input: HTMLInputElement;
}

/** Label + track + hidden checkbox; append the returned label to the form. */
export function switchControl(options: SwitchControlOptions = {}): SwitchControlElement {
  const wrapper = el('label', 'switch');
  const control = el('input', 'switch-input');
  control.type = 'checkbox';
  control.setAttribute('role', 'switch');
  if (options.name !== undefined) control.name = options.name;
  if (options.id !== undefined) control.id = options.id;
  if (options.ariaLabel !== undefined) control.setAttribute('aria-label', options.ariaLabel);
  control.checked = options.checked === true;
  control.disabled = options.disabled === true;
  const track = el('span', 'switch-track');
  track.appendChild(el('span', 'switch-thumb'));
  add(wrapper, control, track);
  if (options.label !== undefined && options.label !== '') {
    add(wrapper, el('span', 'switch-label', options.label));
  }
  if (options.onChange !== undefined) {
    const listener = options.onChange;
    control.addEventListener('change', () => listener(control.checked));
  }
  Object.defineProperty(wrapper, 'input', { value: control, enumerable: false });
  return wrapper as SwitchControlElement;
}

export type ToastTone = ComponentTone;

export interface ToastOptions {
  tone?: ToastTone;
  /** Visible time in milliseconds; defaults to 2800, or 4200 for errors. */
  duration?: number;
  title?: string;
}

/** Transient top-center toast; stack order is oldest first. Returns the toast element. */
export function toast(
  message: string,
  toneOrOptions: ToastTone | ToastOptions = 'info',
  maybeOptions: ToastOptions = {},
): HTMLElement {
  const options: ToastOptions =
    typeof toneOrOptions === 'string'
      ? { ...maybeOptions, tone: toneOrOptions }
      : toneOrOptions;
  const tone = canonicalTone(options.tone);
  const duration = options.duration ?? (tone === 'error' ? 4200 : 2800);
  const stack = ensureToastStack();
  const item = el('div', `toast toast-${tone}`);
  item.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  const glyph =
    tone === 'error' ? 'alert' : tone === 'ok' ? 'check-circle' : tone === 'info' ? 'info' : 'dot';
  add(item, icon(glyph, 16));
  const text = el('div', 'toast-text');
  if (options.title !== undefined && options.title !== '') {
    add(text, el('strong', 'toast-title', options.title));
  }
  add(text, el('span', 'toast-message', message));
  add(item, text);
  stack.appendChild(item);
  while (stack.childElementCount > 4) stack.firstElementChild?.remove();
  window.setTimeout(() => {
    item.classList.add('is-leaving');
    window.setTimeout(() => {
      item.remove();
      if (stack.childElementCount === 0) stack.remove();
    }, 160);
  }, Math.max(600, duration));
  return item;
}

function ensureToastStack(): HTMLElement {
  const existing = document.querySelector<HTMLElement>('[data-toast-stack]');
  if (existing !== null) return existing;
  const stack = el('div', 'toast-stack');
  stack.dataset['toastStack'] = 'true';
  stack.setAttribute('aria-live', 'polite');
  stack.setAttribute('aria-atomic', 'false');
  document.body.appendChild(stack);
  return stack;
}

/** Page section with a title and one-line summary; `body` is the content column. */
export function pageFrame(
  title: string,
  summary: string,
): { section: HTMLElement; body: HTMLElement } {
  const section = el('section', 'page');
  const header = el('header', 'page-header');
  add(header, el('h1', 'page-title', title), el('p', 'page-summary muted', summary));
  const body = el('div', 'page-body');
  add(section, header, body);
  return { section, body };
}

export interface TabIntroOptions {
  title: string;
  description: string;
  hint?: string;
}

/** Section intro at the top of a management tab: title, one-line scope, optional hint. */
export function tabIntro(options: TabIntroOptions): HTMLElement {
  const intro = el('header', 'tab-intro');
  add(
    intro,
    el('h2', 'tab-intro-title', options.title),
    el('p', 'tab-intro-description', options.description),
  );
  if (options.hint !== undefined && options.hint !== '') {
    const hint = el('p', 'tab-intro-hint');
    add(hint, icon('info', 13), el('span', '', options.hint));
    add(intro, hint);
  }
  return intro;
}

export interface FieldOptions {
  /** Guidance shown below the control when there is no error. */
  hint?: string;
  /** Validation message; marks the control `aria-invalid` and is announced by AT. */
  error?: string;
}

/** Label + control pair used by every form on the management page. */
export function field(
  labelText: string,
  control: HTMLElement,
  options: FieldOptions = {},
): HTMLLabelElement {
  const wrapper = el('label', 'field');
  add(wrapper, el('span', 'field-label', labelText), control);
  const describedBy: string[] = [];

  if (options.hint !== undefined && options.hint !== '') {
    const hint = el('span', 'field-hint', options.hint);
    hint.id = nextSharedId('field-hint');
    describedBy.push(hint.id);
    add(wrapper, hint);
  }

  if (options.error !== undefined && options.error !== '') {
    const message = el('span', 'field-error', options.error);
    message.id = nextSharedId('field-error');
    describedBy.push(message.id);
    control.setAttribute('aria-invalid', 'true');
    add(wrapper, message);
  }

  if (describedBy.length > 0) {
    const existing = control.getAttribute('aria-describedby');
    const ids = describedBy.join(' ');
    control.setAttribute(
      'aria-describedby',
      existing === null || existing === '' ? ids : `${existing} ${ids}`,
    );
  }
  return wrapper;
}

// ---------------------------------------------------------------------------
// Management UX components
// ---------------------------------------------------------------------------

let sharedIdSequence = 0;

function nextSharedId(prefix: string): string {
  sharedIdSequence += 1;
  return `${prefix}-${sharedIdSequence}`;
}

export interface SectionGroupOptions {
  title: string;
  description?: string;
  /** Initial expanded state for the collapsible variant; collapsed when omitted. */
  open?: boolean;
  collapsible?: boolean;
  body: HTMLElement[];
}

function sectionGroupHeading(description: string | undefined): HTMLElement | null {
  if (description === undefined || description === '') return null;
  return el('p', 'section-group-description', description);
}

/** Card-level group used by the server editor; `<details>` when `collapsible`. */
export function sectionGroup(options: SectionGroupOptions): HTMLElement {
  const body = el('div', 'section-group-body');
  for (const child of options.body) body.appendChild(child);

  if (options.collapsible === true) {
    const details = el('details', 'section-group section-group-collapsible');
    details.open = options.open === true;
    const summary = el('summary', 'section-group-summary');
    const heading = el('span', 'section-group-heading');
    add(heading, el('span', 'section-group-title', options.title));
    if (options.description !== undefined && options.description !== '') {
      add(heading, el('span', 'section-group-description', options.description));
    }
    add(summary, heading);
    add(details, summary, body);
    return details;
  }

  const section = el('section', 'card section-group');
  const header = el('header', 'section-group-header');
  const heading = el('div', 'section-group-heading');
  add(heading, el('h3', 'section-group-title', options.title));
  const description = sectionGroupHeading(options.description);
  if (description !== null) add(heading, description);
  add(header, heading);
  add(section, header, body);
  return section;
}

export type InlineProgressState = 'running' | 'done' | 'error';

export interface InlineProgressOptions {
  label: string;
  detail?: string;
  state: InlineProgressState;
  onRetry?: () => void;
}

export interface InlineProgressHandle {
  readonly element: HTMLElement;
  /** Updates the state and, when provided, replaces the detail line. */
  update(state: InlineProgressState, detail?: string): void;
}

/** Inline status row for long-running actions; announced through `aria-live="polite"`. */
export function inlineProgress(options: InlineProgressOptions): InlineProgressHandle {
  const element = el('div', 'inline-progress');
  element.setAttribute('aria-live', 'polite');

  const indicator = el('span', 'inline-progress-indicator');
  indicator.setAttribute('aria-hidden', 'true');
  const text = el('span', 'inline-progress-text');
  const label = el('span', 'inline-progress-label', options.label);
  const detail = el('span', 'inline-progress-detail');
  add(text, label, detail);

  const track = el('span', 'inline-progress-track');
  track.setAttribute('aria-hidden', 'true');
  add(track, el('span', 'inline-progress-fill'));

  let retry: HTMLButtonElement | null = null;
  if (options.onRetry !== undefined) {
    const callback = options.onRetry;
    retry = button('重试', () => callback(), { size: 'sm', variant: 'secondary' });
    retry.classList.add('inline-progress-retry');
  }

  function update(state: InlineProgressState, nextDetail?: string): void {
    element.dataset['state'] = state;
    if (nextDetail !== undefined) detail.textContent = nextDetail;
    detail.hidden = detail.textContent === '';
    track.hidden = state !== 'running';
    if (retry !== null) retry.hidden = state !== 'error';
  }

  add(element, indicator, text, track);
  if (retry !== null) add(element, retry);
  update(options.state, options.detail);
  return { element, update };
}

export interface StatusDetailOptions {
  label: string;
  tone: Tone;
  detail: string;
  /** Expanded diagnostics such as lastError, last refresh and a suggested action. */
  lines?: string[];
}

/**
 * Status badge with a disclosure for diagnostics. With no `lines` it renders as a
 * static row; otherwise the head is a native `<button>` (Enter/Space work) that
 * toggles `aria-expanded` and the panel.
 */
export function statusDetail(options: StatusDetailOptions): HTMLElement {
  const wrapper = el('div', 'status-detail');
  const lines = options.lines?.filter((line) => line !== '') ?? [];

  if (lines.length === 0) {
    const row = el('div', 'status-detail-head');
    add(row, badge(options.label, options.tone), el('span', 'status-detail-text', options.detail));
    add(wrapper, row);
    return wrapper;
  }

  const panelId = nextSharedId('status-detail');
  const toggle = el('button', 'status-detail-toggle');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-controls', panelId);
  add(
    toggle,
    badge(options.label, options.tone),
    el('span', 'status-detail-text', options.detail),
    el('span', 'status-detail-chevron'),
  );

  const panel = el('div', 'status-detail-lines');
  panel.id = panelId;
  panel.hidden = true;
  const list = el('ul', 'status-detail-list');
  for (const line of lines) add(list, el('li', '', line));
  add(panel, list);

  toggle.addEventListener('click', () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    panel.hidden = expanded;
  });

  const row = el('div', 'status-detail-head');
  add(row, toggle);
  add(wrapper, row, panel);
  return wrapper;
}

export interface TemplateCardOptions {
  title: string;
  description: string;
  icon?: string;
  onClick: () => void;
}

/** Clickable template tile used as empty-table guidance; rendered as a real button. */
export function templateCard(options: TemplateCardOptions): HTMLElement {
  const card = el('button', 'template-card');
  card.type = 'button';

  if (options.icon !== undefined) {
    const glyph = el('span', 'template-card-icon');
    glyph.setAttribute('aria-hidden', 'true');
    add(glyph, icon(options.icon, 18));
    add(card, glyph);
  }

  const text = el('span', 'template-card-text');
  add(
    text,
    el('span', 'template-card-title', options.title),
    el('span', 'template-card-description', options.description),
  );
  const arrow = el('span', 'template-card-arrow');
  arrow.setAttribute('aria-hidden', 'true');
  add(arrow, icon('arrow-right', 14));

  add(card, text, arrow);
  card.addEventListener('click', () => options.onClick());
  return card;
}

const ERROR_ACTION_HINTS: Readonly<Record<string, string>> = {
  CAPACITY_EXCEEDED: '并发容量已满，请等待运行中的任务结束后重试。',
  WS_LIMIT: '工作区数量已达上限，请先移除不再使用的工作区。',
  WS_INVALID: '工作区路径不可用，请检查路径是否存在且可访问。',
  MCP_SERVER_UNAVAILABLE: 'MCP server 当前不可用，请检查进程状态后重试。',
  MCP_QUEUE_FULL: '该 server 的调用队列已满，请稍后重试。',
  MCP_CALL_TIMEOUT: 'MCP 调用超时，请检查 server 状态或调大 timeoutMs 后重试。',
  EXCLUSIVE_TIMEOUT: '等待独占调用超时，请稍后重试。',
  AI_RUNNER_UNAVAILABLE: 'AI 服务不可用，请确认 AI 配置与运行环境后重试。',
};

const DEFAULT_ERROR_ACTION_HINT = '请查看详情后重试。';
const CONFLICT_ACTION_HINT = '配置已在别处修改，请刷新后重试。';

/** Maps a server error code to a Chinese next-step hint; unknown codes use `fallback`. */
export function errorActionHint(code: string | undefined, fallback?: string): string {
  const normalized = code?.trim().toUpperCase() ?? '';
  if (normalized === '409' || normalized === 'CONFLICT' || normalized.endsWith('_CONFLICT')) {
    return CONFLICT_ACTION_HINT;
  }
  const exact = ERROR_ACTION_HINTS[normalized];
  if (exact !== undefined) return exact;
  if (normalized.startsWith('DISCOVERY_')) {
    if (normalized === 'DISCOVERY_BUSY') return '已有扫描正在进行，请稍后重试。';
    if (normalized === 'DISCOVERY_EMPTY_PREVIEW') {
      return '预览结果为空，请调整查询条件后重新预览。';
    }
    if (normalized === 'DISCOVERY_PARTIAL_STALE_UNCONFIRMED') {
      return '预览不完整，请重新预览并确认。';
    }
    return '工具发现失败，请检查查询条件后重新扫描。';
  }
  if (fallback !== undefined && fallback !== '') return fallback;
  return DEFAULT_ERROR_ACTION_HINT;
}

export interface InputOptions {
  value?: string;
  placeholder?: string;
  name?: string;
  type?: 'text' | 'search' | 'password' | 'number' | 'datetime-local' | 'url';
  min?: string;
  max?: string;
  step?: string;
  required?: boolean;
  disabled?: boolean;
}

export function input(options: InputOptions = {}): HTMLInputElement {
  const control = el('input');
  control.classList.add('input');
  control.type = options.type ?? 'text';
  if (options.value !== undefined) control.value = options.value;
  if (options.placeholder !== undefined) control.placeholder = options.placeholder;
  if (options.name !== undefined) control.name = options.name;
  if (options.min !== undefined) control.min = options.min;
  if (options.max !== undefined) control.max = options.max;
  if (options.step !== undefined) control.step = options.step;
  if (options.required === true) control.required = true;
  if (options.disabled === true) control.disabled = true;
  return control;
}

export function textarea(options: InputOptions & { rows?: number } = {}): HTMLTextAreaElement {
  const control = el('textarea', 'textarea');
  if (options.value !== undefined) control.value = options.value;
  if (options.placeholder !== undefined) control.placeholder = options.placeholder;
  if (options.name !== undefined) control.name = options.name;
  if (options.rows !== undefined) control.rows = options.rows;
  if (options.required === true) control.required = true;
  if (options.disabled === true) control.disabled = true;
  return control;
}

export function select(
  entries: ReadonlyArray<{ value: string; label: string }>,
  selected: string,
): HTMLSelectElement {
  const control = el('select', 'select');
  for (const entry of entries) {
    const option = el('option', '', entry.label);
    option.value = entry.value;
    if (entry.value === selected) option.selected = true;
    control.appendChild(option);
  }
  if (selected !== '') control.value = selected;
  return control;
}

export function checkbox(labelText: string, checked: boolean): {
  wrapper: HTMLLabelElement;
  input: HTMLInputElement;
} {
  const control = el('input');
  control.type = 'checkbox';
  control.checked = checked;
  const wrapper = el('label', 'checkbox');
  add(wrapper, control, el('span', 'checkbox-label', labelText));
  return { wrapper, input: control };
}

export function formError(): HTMLParagraphElement {
  const line = el('p', 'form-error');
  line.hidden = true;
  line.setAttribute('role', 'alert');
  return line;
}

export function setFormError(line: HTMLElement, message: string | null): void {
  if (message === null || message === '') {
    line.textContent = '';
    line.hidden = true;
    return;
  }
  line.textContent = message;
  line.hidden = false;
}

/** Human-readable error text; code and status stay visible for API failures. */
export function describeError(error: unknown): string {
  if (error instanceof ApiError) {
    const status = error.status === 0 ? '' : ` · HTTP ${error.status}`;
    return `${error.message}（${error.code}${status}）`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export type NoticeTone = 'info' | 'ok' | 'error' | 'queue';

/** Inline banner with a semantic icon and background. It is not auto-dismissed. */
export function notice(message: string, tone: NoticeTone = 'info'): HTMLElement {
  const banner = el('div', `notice notice-${tone}`);
  banner.setAttribute('role', tone === 'error' ? 'alert' : 'status');
  const glyph = tone === 'error' ? 'alert' : tone === 'ok' ? 'check-circle' : tone === 'queue' ? 'alert' : 'info';
  add(banner, icon(glyph, 16), el('span', 'notice-message', message));
  return banner;
}

export function emptyState(message: string, hint?: string): HTMLElement {
  const box = el('div', 'card empty-state');
  add(box, icon('inbox', 26));
  const body = el('div', 'empty-body');
  add(body, el('p', 'empty-title', message));
  if (hint !== undefined) add(body, el('p', 'empty-hint', hint));
  add(box, body);
  return box;
}

export function loading(message = '正在加载…'): HTMLElement {
  const box = el('div', 'card empty-state loading');
  box.setAttribute('role', 'status');
  add(box, el('span', 'spinner'), el('p', 'empty-hint', message));
  return box;
}

/** Copies text with the async Clipboard API and falls back to a hidden textarea. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator.clipboard?.writeText === 'function') {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Permission denied or an insecure context: use the legacy path below.
  }

  const area = el('textarea');
  area.value = value;
  setStyle(area, { position: 'fixed', opacity: '0', pointerEvents: 'none' });
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

/** Copy button that briefly confirms success in place. */
export function copyButton(label: string, read: () => string): HTMLButtonElement {
  const control = button(label, () => {
    void copyText(read()).then((copied) => {
      if (!control.isConnected) return;
      control.textContent = copied ? '已复制' : '复制失败';
      window.setTimeout(() => {
        if (control.isConnected) control.textContent = label;
      }, 1200);
    });
  });
  control.classList.add('ghost');
  return control;
}

export function confirmAction(message: string): boolean {
  return window.confirm(message);
}

/** Small key/value grid used inside drawers and detail panels. */
export function definitionList(
  entries: ReadonlyArray<{ label: string; value: Node | string; mono?: boolean }>,
): HTMLElement {
  const grid = el('dl', 'definition-list');
  setStyle(grid, {
    display: 'grid',
    gridTemplateColumns: 'max-content 1fr',
    gap: '6px 16px',
    margin: '0',
    fontSize: '13px',
  });
  for (const entry of entries) {
    const term = el('dt', 'muted', entry.label);
    const value = el('dd');
    setStyle(value, { margin: '0', wordBreak: 'break-all' });
    if (entry.mono === true) value.className = 'mono';
    add(value, entry.value);
    add(grid, term, value);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Drawer
// ---------------------------------------------------------------------------

export interface DrawerController {
  readonly isOpen: boolean;
  open(title: string, body: Node): void;
  close(): void;
  destroy(): void;
}

/**
 * Uses the shell drawer (`[data-drawer]` + `[data-drawer-backdrop]`) when present and
 * creates a local fixed drawer otherwise, so a page works both inside the shell and in
 * isolation. Only one drawer instance per page should exist.
 */
export function createDrawer(): DrawerController {
  const shellDrawer = document.querySelector<HTMLElement>('[data-drawer]');
  const shellBackdrop = document.querySelector<HTMLElement>('[data-drawer-backdrop]');

  let drawer: HTMLElement;
  let backdrop: HTMLElement;
  let owned = false;

  if (shellDrawer !== null && shellBackdrop !== null) {
    drawer = shellDrawer;
    backdrop = shellBackdrop;
  } else {
    owned = true;
    drawer = el('aside', 'drawer');
    backdrop = el('div', 'drawer-backdrop');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('aria-label', '详情');
    drawer.dataset['open'] = 'false';
    backdrop.dataset['open'] = 'false';
    add(document.body, backdrop, drawer);
  }

  let opened = false;

  function close(): void {
    if (!opened) return;
    opened = false;
    drawer.dataset['open'] = 'false';
    drawer.setAttribute('aria-hidden', 'true');
    backdrop.dataset['open'] = 'false';
    drawer.replaceChildren();
    document.body.classList.remove('drawer-open');
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && opened) {
      event.preventDefault();
      close();
    }
  };
  const onBackdrop = (): void => close();

  document.addEventListener('keydown', onKeydown);
  backdrop.addEventListener('click', onBackdrop);

  function open(title: string, body: Node): void {
    opened = true;
    const header = el('div', 'drawer-header');
    const heading = el('h2', '', title);
    setStyle(heading, { fontSize: '17px', margin: '0' });
    add(header, heading, button('关闭', () => close(), { variant: 'ghost' }));
    const content = el('div', 'drawer-body');
    add(content, body);
    drawer.replaceChildren(header, content);
    drawer.dataset['open'] = 'true';
    drawer.setAttribute('aria-hidden', 'false');
    backdrop.dataset['open'] = 'true';
    document.body.classList.add('drawer-open');
    drawer.scrollTop = 0;
  }

  function destroy(): void {
    close();
    document.removeEventListener('keydown', onKeydown);
    backdrop.removeEventListener('click', onBackdrop);
    if (owned) {
      drawer.remove();
      backdrop.remove();
    }
  }

  return {
    get isOpen() {
      return opened;
    },
    open,
    close,
    destroy,
  };
}

// ---------------------------------------------------------------------------
// Polling
// ---------------------------------------------------------------------------

export interface Polling {
  stop(): void;
  runNow(): void;
}

/**
 * Fixed-interval polling that pauses while the document is hidden and resumes with an
 * immediate run when it becomes visible again. The next tick is scheduled after the
 * previous run settles, so a slow request never stacks callbacks.
 */
export function startPolling(
  run: () => Promise<void> | void,
  intervalMs: number,
): Polling {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let running = false;

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    if (stopped || document.visibilityState === 'hidden') return;
    clearTimer();
    timer = window.setTimeout(() => {
      timer = null;
      void tick();
    }, intervalMs);
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    if (document.visibilityState === 'hidden') return;
    if (running) {
      schedule();
      return;
    }
    running = true;
    try {
      await run();
    } catch {
      // The page renders its own error banner; polling must keep its cadence.
    } finally {
      running = false;
      schedule();
    }
  }

  function onVisibility(): void {
    if (stopped) return;
    if (document.visibilityState === 'hidden') {
      clearTimer();
      return;
    }
    void tick();
  }

  document.addEventListener('visibilitychange', onVisibility);
  if (document.visibilityState !== 'hidden') {
    timer = window.setTimeout(() => {
      timer = null;
      void tick();
    }, intervalMs);
  }

  return {
    stop(): void {
      stopped = true;
      clearTimer();
      document.removeEventListener('visibilitychange', onVisibility);
    },
    runNow(): void {
      if (!stopped) void tick();
    },
  };
}

/** Adds `document` visibility handling that can be removed in one call. */
export function onVisibilityChange(listener: () => void): () => void {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}
