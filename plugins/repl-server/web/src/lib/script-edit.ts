/**
 * Pure form validation for admin script edits (`10 §9.2–9.3`, P2).
 *
 * Kept out of the page so the exact/parameterized rules and the candidate
 * accept body are testable without React or a backend.
 * @module
 */

export type EditOutcome<T> = { ok: true; body: T } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(text: string, label: string): EditOutcome<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: `${label} 不是合法 JSON` };
  }
  return isPlainObject(value)
    ? { ok: true, body: value }
    : { ok: false, error: `${label} 必须是 JSON 对象` };
}

export interface VersionEditFields {
  /** `exact` / `parameterized`; anything else cannot be submitted. */
  mode: string | null;
  code: string;
  inputSchema: string;
  exampleArgs: string;
  /** Successful `run_script` id; required for exact updates and never sent as code. */
  runId: string;
}

/**
 * Builds `POST /scripts/:id/versions`'s body.
 *
 * exact versions take their code from the source run, so the request carries
 * `runId` and no `code`; parameterized versions carry code, schema and optional
 * example args. P2 adds `runId` to the endpoint's accepted fields.
 */
export function versionEditBody(
  fields: VersionEditFields,
): EditOutcome<Record<string, unknown>> {
  if (fields.mode === 'exact') {
    const runId = fields.runId.trim();
    if (runId === '') {
      return { ok: false, error: 'exact 版本必须填写来源 runId（一次成功的 run_script 执行）' };
    }
    return { ok: true, body: { mode: 'exact', runId } };
  }
  if (fields.mode !== 'parameterized') {
    return { ok: false, error: '无法确定脚本模式（exact / parameterized）' };
  }
  if (fields.code.trim() === '') {
    return { ok: false, error: 'code 不能为空' };
  }
  const schema = parseObject(fields.inputSchema, 'inputSchema');
  if (!schema.ok) return schema;
  const body: Record<string, unknown> = {
    mode: 'parameterized',
    code: fields.code,
    inputSchema: schema.body,
  };
  if (fields.exampleArgs.trim() !== '') {
    const exampleArgs = parseObject(fields.exampleArgs, 'exampleArgs');
    if (!exampleArgs.ok) return exampleArgs;
    body['exampleArgs'] = exampleArgs.body;
  }
  return { ok: true, body };
}

/** Optional `args` for `POST /scripts/:id/test`; blank means "no args". */
export function testArgsFrom(text: string): EditOutcome<Record<string, unknown> | undefined> {
  if (text.trim() === '') return { ok: true, body: undefined };
  return parseObject(text, 'args');
}

export interface CandidateAcceptFields {
  name: string;
  description: string;
  /** Comma/whitespace separated tags. */
  tags: string;
  code: string;
  inputSchema: string;
  exampleArgs: string;
}

function splitTags(text: string): string[] {
  return text
    .split(/[,，\s]+/u)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/** Builds `POST /script-candidates/:id/accept`'s body after the review edits. */
export function candidateAcceptBody(
  fields: CandidateAcceptFields,
): EditOutcome<Record<string, unknown>> {
  const name = fields.name.trim();
  if (name === '') return { ok: false, error: 'name 不能为空' };
  if (fields.code.trim() === '') return { ok: false, error: 'code 不能为空' };
  const schema = parseObject(fields.inputSchema, 'inputSchema');
  if (!schema.ok) return schema;
  const body: Record<string, unknown> = {
    name,
    tags: splitTags(fields.tags),
    code: fields.code,
    inputSchema: schema.body,
  };
  const description = fields.description.trim();
  if (description !== '') body['description'] = description;
  if (fields.exampleArgs.trim() !== '') {
    const exampleArgs = parseObject(fields.exampleArgs, 'exampleArgs');
    if (!exampleArgs.ok) return exampleArgs;
    body['exampleArgs'] = exampleArgs.body;
  }
  return { ok: true, body };
}
