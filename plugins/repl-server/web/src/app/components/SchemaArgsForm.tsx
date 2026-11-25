/**
 * Controlled JSON Schema argument form shared by the tool test drawer and the
 * script test dialog (`POST /tools/:serverId/:name/test`, `POST /scripts/:id/test`).
 *
 * Typed fields keep their JSON types (number/boolean/enum values never become
 * strings). A field that cannot be typed safely, or the whole root schema, falls
 * back to a raw JSON editor; the user can also switch modes by hand.
 */
import { Alert, Input, InputNumber, Segmented, Select, Space, Typography } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import { formatJson } from '../../lib/format.ts';
import {
  argsFormPlan,
  argsFromJsonText,
  jsonValueFromText,
  missingRequiredFields,
  type ArgsField,
} from '../../lib/schema-args.ts';

export interface SchemaArgsFormProps {
  /** Tool/script `inputSchema`; malformed values switch to JSON mode instead of throwing. */
  schema: unknown;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  /** Fires when args stop/start being valid; invalid raw JSON must block submit. */
  onValidityChange?: (valid: boolean) => void;
  disabled?: boolean;
}

export function SchemaArgsForm({
  schema,
  value,
  onChange,
  onValidityChange,
  disabled = false,
}: SchemaArgsFormProps): React.ReactElement {
  const plan = useMemo(() => argsFormPlan(schema), [schema]);
  const [mode, setMode] = useState<'form' | 'json'>(() =>
    plan.mode === 'json' ? 'json' : 'form',
  );
  const [jsonText, setJsonText] = useState(() => formatJson(value, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string | null>>({});

  // A schema that arrives after mount (or changes) must land in JSON mode.
  useEffect(() => {
    if (plan.mode !== 'json') return;
    setMode('json');
    setJsonError(null);
  }, [plan.mode]);

  const missing = mode === 'form' ? missingRequiredFields(plan, value) : [];
  const missingNames = new Set(missing.map((field) => field.name));
  const valid =
    mode === 'json'
      ? jsonError === null
      : missing.length === 0 &&
        Object.values(fieldErrors).every((error) => error === null);

  useEffect(() => {
    onValidityChange?.(valid);
  }, [onValidityChange, valid]);

  function setField(name: string, next: unknown): void {
    onChange({ ...value, [name]: next });
  }

  function clearField(name: string): void {
    const next = { ...value };
    delete next[name];
    onChange(next);
  }

  function setFieldError(name: string, error: string | null): void {
    setFieldErrors((prev) => (prev[name] === error ? prev : { ...prev, [name]: error }));
  }

  function changeMode(next: string | number): void {
    if ((next !== 'form' && next !== 'json') || next === mode) return;
    if (next === 'json') {
      setJsonText(formatJson(value, 2));
      setJsonError(null);
    } else {
      setFieldErrors({});
    }
    setMode(next);
  }

  function changeJsonText(text: string): void {
    setJsonText(text);
    const parsed = argsFromJsonText(text);
    if (!parsed.ok) {
      setJsonError(parsed.error);
      return;
    }
    setJsonError(null);
    onChange(parsed.value);
  }

  function renderInput(field: ArgsField): React.ReactNode {
    const current = value[field.name];
    switch (field.kind) {
      case 'string': {
        const text = typeof current === 'string' ? current : '';
        return (
          <Input
            value={text}
            disabled={disabled}
            allowClear={!field.required}
            placeholder={field.required ? '必填' : '可选'}
            onChange={(event) => {
              const next = event.target.value;
              if (next === '' && !field.required) clearField(field.name);
              else setField(field.name, next);
            }}
          />
        );
      }
      case 'integer':
      case 'number':
        return (
          <InputNumber
            style={{ width: '100%' }}
            disabled={disabled}
            precision={field.kind === 'integer' ? 0 : undefined}
            step={field.kind === 'integer' ? 1 : undefined}
            placeholder={field.required ? '必填数字' : '可选数字'}
            value={typeof current === 'number' && Number.isFinite(current) ? current : null}
            onChange={(next) => {
              if (typeof next === 'number' && Number.isFinite(next)) setField(field.name, next);
              else clearField(field.name);
            }}
          />
        );
      case 'boolean':
        return (
          <Select
            style={{ width: 180 }}
            disabled={disabled}
            allowClear={!field.required}
            placeholder="未设置"
            value={typeof current === 'boolean' ? String(current) : undefined}
            options={[
              { value: 'true', label: 'true' },
              { value: 'false', label: 'false' },
            ]}
            onChange={(next?: string) => {
              if (next === undefined) clearField(field.name);
              else setField(field.name, next === 'true');
            }}
          />
        );
      case 'enum': {
        const options = field.enumValues ?? [];
        const index = options.findIndex((option) => Object.is(option, current));
        return (
          <Select
            style={{ width: '100%' }}
            disabled={disabled}
            allowClear={!field.required}
            placeholder={field.required ? '必选' : '可选'}
            value={index >= 0 ? String(index) : undefined}
            options={options.map((option, optionIndex) => ({
              value: String(optionIndex),
              label: typeof option === 'string' ? option : JSON.stringify(option),
            }))}
            onChange={(next?: string) => {
              if (next === undefined) clearField(field.name);
              else setField(field.name, options[Number(next)]);
            }}
          />
        );
      }
      case 'string-array': {
        const items = Array.isArray(current)
          ? current.filter((item): item is string => typeof item === 'string')
          : [];
        return (
          <Select
            mode="tags"
            style={{ width: '100%' }}
            disabled={disabled}
            tokenSeparators={[',', '，']}
            placeholder="输入后回车添加"
            value={items}
            onChange={(next: string[]) => {
              if (next.length === 0) clearField(field.name);
              else setField(field.name, next);
            }}
          />
        );
      }
      case 'json':
        return (
          <JsonFieldInput
            field={field}
            value={current}
            disabled={disabled}
            onChange={(next, present) => {
              if (present) setField(field.name, next);
              else clearField(field.name);
            }}
            onError={(error) => setFieldError(field.name, error)}
          />
        );
    }
  }

  const jsonModeOption = { label: '表单', value: 'form', disabled: plan.mode === 'json' };

  return (
    <Space direction="vertical" size={10} style={{ width: '100%' }}>
      <Space size={8} wrap>
        <Segmented
          size="small"
          value={mode}
          disabled={disabled}
          options={[jsonModeOption, { label: 'JSON', value: 'json' }]}
          onChange={changeMode}
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          复杂 schema 或手写参数可切换到 JSON 模式
        </Typography.Text>
      </Space>
      {plan.mode === 'json' ? (
        <Alert type="info" showIcon message={plan.reason ?? '该 schema 无法生成表单，已切换到 JSON 模式。'} />
      ) : null}
      {mode === 'json' ? (
        <>
          <Input.TextArea
            value={jsonText}
            disabled={disabled}
            autoSize={{ minRows: 8, maxRows: 18 }}
            className="mono"
            placeholder={'{\n  "example": "value"\n}'}
            onChange={(event) => changeJsonText(event.target.value)}
          />
          {jsonError === null ? null : <Alert type="error" showIcon message={jsonError} />}
        </>
      ) : plan.fields.length === 0 ? (
        <Typography.Text type="secondary">
          该 schema 没有声明参数；需要自由参数时切换到 JSON 模式。
        </Typography.Text>
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          {plan.fields.map((field) => (
            <div key={field.name}>
              <div>
                <Typography.Text strong>{field.label}</Typography.Text>
                {field.required ? <span style={{ color: '#d4380d' }}> *</span> : null}
                <span className="mono muted" style={{ marginLeft: 8 }}>
                  {field.name}
                </span>
              </div>
              {field.description === null ? null : (
                <div className="muted" style={{ fontSize: 12, margin: '2px 0 4px' }}>
                  {field.description}
                </div>
              )}
              {renderInput(field)}
              {missingNames.has(field.name) ? (
                <div style={{ color: '#d4380d', fontSize: 12, marginTop: 2 }}>必填参数未填写</div>
              ) : null}
            </div>
          ))}
        </Space>
      )}
    </Space>
  );
}

/** Raw-JSON editor for one field the typed controls cannot represent. */
function JsonFieldInput({
  field,
  value,
  disabled,
  onChange,
  onError,
}: {
  field: ArgsField;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown, present: boolean) => void;
  onError: (error: string | null) => void;
}): React.ReactElement {
  const [text, setText] = useState(() => (value === undefined ? '' : formatJson(value, 2)));
  const [error, setError] = useState<string | null>(null);

  function change(next: string): void {
    setText(next);
    const parsed = jsonValueFromText(next);
    if (!parsed.ok) {
      setError(parsed.error);
      onError(parsed.error);
      return;
    }
    setError(null);
    onError(null);
    onChange(parsed.value, parsed.present);
  }

  return (
    <div>
      <Input.TextArea
        value={text}
        disabled={disabled}
        autoSize={{ minRows: 3, maxRows: 10 }}
        className="mono"
        placeholder="留空表示不传该参数"
        onChange={(event) => change(event.target.value)}
      />
      {error === null ? null : (
        <div style={{ color: '#d4380d', fontSize: 12, marginTop: 2 }}>{error}</div>
      )}
      {field.fallbackReason === null ? null : (
        <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
          {field.fallbackReason}
        </div>
      )}
    </div>
  );
}
