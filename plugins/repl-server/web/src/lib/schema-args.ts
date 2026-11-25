/**
 * Plans a JSON Schema `inputSchema` into form fields for {@link SchemaArgsForm}.
 *
 * Only a root object with flat, well-known property shapes becomes a form. Anything
 * the form cannot type safely (`oneOf`/`anyOf`/`$ref`, unions, nested objects,
 * non-string arrays) falls back to a raw-JSON editor for that field, or for the whole
 * args object when the root itself is unsupported.
 * @module
 */

export type ArgsFieldKind =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'enum'
  | 'string-array'
  | 'json';

export interface ArgsField {
  name: string;
  /** `title` when present, otherwise the property name. */
  label: string;
  description: string | null;
  required: boolean;
  kind: ArgsFieldKind;
  /** Enum values keep their original JSON types. */
  enumValues: unknown[] | null;
  /** Why this field is edited as raw JSON; null for typed fields. */
  fallbackReason: string | null;
}

export interface ArgsFormPlan {
  /** `json` means the root schema itself cannot be rendered as a form. */
  mode: 'form' | 'json';
  /** Human-readable reason for `mode: 'json'`. */
  reason: string | null;
  fields: ArgsField[];
}

export type ObjectArgsOutcome =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

export type JsonValueOutcome =
  | { ok: true; present: boolean; value?: unknown }
  | { ok: false; error: string };

/** Builds the form plan for one tool/script `inputSchema`; never throws. */
export function argsFormPlan(schema: unknown): ArgsFormPlan {
  if (schema === undefined || schema === null) {
    return { mode: 'form', reason: null, fields: [] };
  }
  if (!isRecord(schema)) {
    return {
      mode: 'json',
      reason: '参数 schema 不是 JSON 对象，无法生成表单；请在 JSON 模式填写。',
      fields: [],
    };
  }
  const unsupported = rootUnsupportedReason(schema);
  if (unsupported !== null) return { mode: 'json', reason: unsupported, fields: [] };

  const properties = schema['properties'];
  if (properties !== undefined && !isRecord(properties)) {
    return {
      mode: 'json',
      reason: '参数 schema 的 properties 不是对象，无法生成表单；请在 JSON 模式填写。',
      fields: [],
    };
  }
  const required = readRequired(schema['required']);
  const fields = Object.entries(properties ?? {}).map(([name, child]) =>
    fieldFrom(name, child, required.has(name)),
  );
  return { mode: 'form', reason: null, fields };
}

/** Parses the whole-args JSON editor text; blank means an empty object. */
export function argsFromJsonText(text: string): ObjectArgsOutcome {
  if (text.trim() === '') return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: '参数不是合法 JSON' };
  }
  return isRecord(parsed)
    ? { ok: true, value: parsed }
    : { ok: false, error: '参数必须是 JSON 对象' };
}

/**
 * Parses one raw-JSON field editor. Blank is reported as `present: false` so the
 * key is removed from the args object instead of becoming `null`.
 */
export function jsonValueFromText(text: string): JsonValueOutcome {
  if (text.trim() === '') return { ok: true, present: false };
  try {
    return { ok: true, present: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: '不是合法 JSON' };
  }
}

/** Copies a saved `exampleArgs` object; non-objects become `{}`. */
export function argsObjectFrom(value: unknown): Record<string, unknown> {
  return isRecord(value) ? { ...value } : {};
}

/**
 * Required form fields with no usable value. Only fields the form renders count;
 * `enum` fields are included, and `0`/`false` are valid values, not "missing".
 */
export function missingRequiredFields(
  plan: ArgsFormPlan,
  args: Record<string, unknown>,
): ArgsField[] {
  return plan.fields.filter(
    (field) =>
      field.required
      && (!Object.hasOwn(args, field.name) || isMissingValue(args[field.name])),
  );
}

function isMissingValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  return typeof value === 'string' && value.trim() === '';
}

function rootUnsupportedReason(schema: Record<string, unknown>): string | null {
  if (typeof schema['$ref'] === 'string') {
    return '根 schema 使用了 $ref 引用，无法生成表单；请在 JSON 模式填写。';
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(schema[key])) {
      return `根 schema 使用了 ${key} 组合，无法生成表单；请在 JSON 模式填写。`;
    }
  }
  const type = schema['type'];
  if (Array.isArray(type)) {
    return '根 schema 是联合类型，无法生成表单；请在 JSON 模式填写。';
  }
  if (typeof type === 'string' && type !== 'object') {
    return `根 schema 的类型是 ${type}，不是 object；请在 JSON 模式填写。`;
  }
  return null;
}

function fieldFrom(name: string, child: unknown, required: boolean): ArgsField {
  const base: ArgsField = {
    name,
    label: name,
    description: null,
    required,
    kind: 'json',
    enumValues: null,
    fallbackReason: null,
  };
  if (!isRecord(child)) {
    return { ...base, fallbackReason: '字段 schema 不是对象，请用 JSON 编辑。' };
  }
  const label = text(child['title']) ?? name;
  const description = text(child['description']);
  const field: ArgsField = { ...base, label, description };

  if (typeof child['$ref'] === 'string') {
    return { ...field, fallbackReason: '字段使用了 $ref 引用，请用 JSON 编辑。' };
  }
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    if (Array.isArray(child[key])) {
      return { ...field, fallbackReason: `字段使用了 ${key} 组合，请用 JSON 编辑。` };
    }
  }
  if (Array.isArray(child['enum']) && child['enum'].length > 0) {
    return { ...field, kind: 'enum', enumValues: [...child['enum']] };
  }

  const type = child['type'];
  if (Array.isArray(type)) {
    return { ...field, fallbackReason: '字段是联合类型，请用 JSON 编辑。' };
  }
  switch (type) {
    case 'string':
      return { ...field, kind: 'string' };
    case 'integer':
      return { ...field, kind: 'integer' };
    case 'number':
      return { ...field, kind: 'number' };
    case 'boolean':
      return { ...field, kind: 'boolean' };
    case 'array':
      return stringArrayField(field, child['items']);
    case 'object':
      return { ...field, fallbackReason: '对象字段请用 JSON 编辑。' };
    default:
      return type === undefined
        ? { ...field, fallbackReason: '字段缺少 type，无法生成表单控件；请用 JSON 编辑。' }
        : { ...field, fallbackReason: `不支持的字段类型 ${String(type)}，请用 JSON 编辑。` };
  }
}

function stringArrayField(field: ArgsField, items: unknown): ArgsField {
  if (!isRecord(items)) {
    return { ...field, fallbackReason: '数组没有声明元素类型，请用 JSON 编辑。' };
  }
  if (
    items['type'] === 'string' &&
    !Array.isArray(items['enum']) &&
    !Array.isArray(items['oneOf']) &&
    !Array.isArray(items['anyOf']) &&
    !Array.isArray(items['allOf']) &&
    typeof items['$ref'] !== 'string'
  ) {
    return { ...field, kind: 'string-array' };
  }
  return { ...field, fallbackReason: '数组元素不是简单字符串，请用 JSON 编辑。' };
}

function readRequired(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
