/** Flattens a tool input schema (JSON Schema) into rows for the tools documentation drawer.
 *
 * The walker is defensive: malformed schemas never throw, and cycles, deep nesting and
 * very wide objects stop early with `truncated: true`.
 * @module
 */

import { formatJson } from './format.ts';

export interface SchemaField {
  /** Dotted path from the schema root; array items use `[]` suffixes (`filters[].field`). */
  path: string;
  /** Leaf key shown in the parameter column. */
  name: string;
  /** Compact type label: `string`, `string | null`, `array<object>`, `$ref:…`, `oneOf(…)`. */
  type: string;
  required: boolean;
  description: string | null;
  /** Schema `default`, stringified; null when absent. */
  defaultValue: string | null;
  /** Schema `enum` values, stringified; null when absent. */
  enumValues: string[] | null;
  /** true allows undeclared keys, false forbids them, null when the schema does not say. */
  additionalProperties: boolean | null;
}

export interface SchemaDoc {
  fields: SchemaField[];
  /** true when the row-count, depth or cycle limits stopped the walk early. */
  truncated: boolean;
}

/** Row cap; keeps the parameter table readable. */
export const SCHEMA_DOC_MAX_FIELDS = 100;
/** Nested-object levels expanded below the root object. */
export const SCHEMA_DOC_MAX_DEPTH = 4;

/** Flattens `schema` into table rows. Accepts any JSON value; non-objects yield no rows. */
export function schemaDoc(schema: unknown): SchemaDoc {
  const fields: SchemaField[] = [];
  // Schemas on the current path, so shared sub-schemas are fine but cycles stop.
  const ancestors = new WeakSet<object>();
  let truncated = false;

  function rowFor(
    node: Record<string, unknown>,
    path: string,
    name: string,
    required: boolean,
  ): SchemaField {
    return {
      path,
      name,
      type: typeLabel(node),
      required,
      description: typeof node['description'] === 'string' ? node['description'] : null,
      defaultValue: node['default'] === undefined ? null : stringifyValue(node['default']),
      enumValues: Array.isArray(node['enum']) ? node['enum'].map(stringifyValue) : null,
      additionalProperties: readAdditionalProperties(node['additionalProperties']),
    };
  }

  function visitObject(node: Record<string, unknown>, prefix: string, depth: number): void {
    if (ancestors.has(node)) {
      truncated = true;
      return;
    }
    const properties = node['properties'];
    if (!isRecord(properties)) return;
    ancestors.add(node);
    const required = readRequired(node['required']);
    for (const [key, child] of Object.entries(properties)) {
      if (fields.length >= SCHEMA_DOC_MAX_FIELDS) {
        truncated = true;
        break;
      }
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (!isRecord(child)) {
        fields.push({
          path,
          name: key,
          type: 'unknown',
          required: required.has(key),
          description: null,
          defaultValue: null,
          enumValues: null,
          additionalProperties: null,
        });
        continue;
      }
      fields.push(rowFor(child, path, key, required.has(key)));
      descend(child, path, depth);
    }
    ancestors.delete(node);
  }

  function descend(node: Record<string, unknown>, path: string, depth: number): void {
    let target = node;
    let targetPath = path;
    // An array property lists its item fields under `name[]`; nested arrays stack `[]`.
    // A self-referential `items` chain (`A.items = A`) would otherwise spin forever.
    const seen: WeakSet<object> = new WeakSet();
    while (isArrayNode(target)) {
      if (seen.has(target)) {
        truncated = true;
        return;
      }
      seen.add(target);
      const items = target['items'];
      if (!isRecord(items)) return;
      target = items;
      targetPath = `${targetPath}[]`;
    }
    const properties = target['properties'];
    if (!isRecord(properties) || Object.keys(properties).length === 0) return;
    if (depth >= SCHEMA_DOC_MAX_DEPTH) {
      truncated = true;
      return;
    }
    visitObject(target, targetPath, depth + 1);
  }

  if (isRecord(schema)) visitObject(schema, '', 0);
  return { fields, truncated };
}

function typeLabel(node: Record<string, unknown>, depth = 0): string {
  const ref = node['$ref'];
  if (typeof ref === 'string' && ref !== '') return `$ref:${ref}`;
  if (depth > SCHEMA_DOC_MAX_DEPTH) return '…';
  for (const key of ['oneOf', 'anyOf', 'allOf'] as const) {
    const variants = node[key];
    if (!Array.isArray(variants) || variants.length === 0) continue;
    const labels = variants
      .slice(0, 3)
      .map((variant) => (isRecord(variant) ? typeLabel(variant, depth + 1) : 'unknown'));
    const rest = variants.length > 3 ? ' | …' : '';
    return `${key}(${labels.join(' | ')}${rest})`;
  }
  const type = node['type'];
  if (Array.isArray(type)) {
    const labels = type.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
    return labels.length === 0 ? 'unknown' : labels.join(' | ');
  }
  if (typeof type === 'string' && type !== '') {
    if (type === 'array') {
      const items = node['items'];
      return isRecord(items) ? `array<${typeLabel(items, depth + 1)}>` : 'array';
    }
    return type;
  }
  if (node['enum'] !== undefined) return 'enum';
  if (isRecord(node['properties']) || node['additionalProperties'] !== undefined) return 'object';
  return 'unknown';
}

function readRequired(value: unknown): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
}

function readAdditionalProperties(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  if (isRecord(value)) return true;
  return null;
}

function isArrayNode(node: Record<string, unknown>): boolean {
  const type = node['type'];
  return type === 'array' || (Array.isArray(type) && type.includes('array'));
}

/** Strings display bare in tables; everything else keeps its JSON text. */
function stringifyValue(value: unknown): string {
  return typeof value === 'string' ? value : formatJson(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
