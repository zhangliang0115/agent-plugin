/** Script identity card shown in request/event detail views (10 §9.1). */
import { Alert, Card, Descriptions, Tag, Typography } from 'antd';

import type { ScriptInfo, ScriptSecretWarning } from '../../lib/script-info.ts';

const { Text } = Typography;

const MODE_LABELS: Readonly<Record<string, string>> = {
  code: '临时代码',
  script: '脚本库',
};

const SCRIPT_MODE_LABELS: Readonly<Record<string, string>> = {
  exact: 'exact（原样）',
  parameterized: 'parameterized（参数化）',
};

const SEVERITY_LABELS: Readonly<Record<string, string>> = {
  high: '高',
  medium: '中',
  low: '低',
};

function warningText(warnings: readonly ScriptSecretWarning[]): string {
  return warnings
    .map((warning) => {
      const severity = warning.severity === null ? '未知' : (SEVERITY_LABELS[warning.severity] ?? warning.severity);
      const count = warning.count === null ? '' : ` ×${warning.count}`;
      return `${severity} · ${warning.kind}${count}`;
    })
    .join('；');
}

/** Renders nothing when the request/event has no script entry metadata. */
export function ScriptInfoCard({ info }: { info: ScriptInfo | null }): React.ReactElement | null {
  if (info === null) return null;
  const args = info.argsPreview;
  const warnings = info.secretWarnings ?? [];
  return (
    <Card size="small" title="脚本">
      <Descriptions column={2} size="small">
        <Descriptions.Item label="入口方式">
          <Tag bordered={false}>
            {(info.entryMode === null ? null : MODE_LABELS[info.entryMode]) ?? info.entryMode ?? '—'}
          </Tag>
        </Descriptions.Item>
        <Descriptions.Item label="scriptId">
          <span className="mono">{info.scriptId ?? '—'}</span>
        </Descriptions.Item>
        <Descriptions.Item label="版本">
          {info.scriptVersion === null ? '—' : `v${info.scriptVersion}`}
        </Descriptions.Item>
        {info.scriptName === null ? null : (
          <Descriptions.Item label="脚本名">{info.scriptName}</Descriptions.Item>
        )}
        {info.scriptMode === null ? null : (
          <Descriptions.Item label="脚本模式">
            {SCRIPT_MODE_LABELS[info.scriptMode] ?? info.scriptMode}
          </Descriptions.Item>
        )}
        <Descriptions.Item label="参数摘要" span={2}>
          {args === null ? (
            <Text type="secondary">—</Text>
          ) : (
            <pre
              className="mono"
              style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 120, overflow: 'auto' }}
            >
              {args}
            </pre>
          )}
        </Descriptions.Item>
      </Descriptions>
      {warnings.length === 0 ? null : (
        <Alert
          style={{ marginTop: 8 }}
          type="warning"
          showIcon
          message="参数摘要疑似包含密钥（仅提示）"
          description={warningText(warnings)}
        />
      )}
    </Card>
  );
}
