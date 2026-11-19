/** Tag dictionary hook plus the multi-select used by server/tool/client forms. */
import { Select, Tag } from 'antd';

import { useDictionaryResource } from './dictionary-resource.ts';

export interface TagDefinition {
  key: string;
  zh: string;
  en: string;
}

export interface TagDictionaryState {
  tags: TagDefinition[];
  revision: number;
  loading: boolean;
  reload(): Promise<void>;
}

/** Loads the dictionary once per session; failures degrade to an empty list. */
export function useTagDictionary(): TagDictionaryState {
  const { entries, revision, loading, reload } = useDictionaryResource('/tags', 'tags');
  return { tags: entries, revision, loading, reload };
}

export function tagLabel(tags: readonly TagDefinition[], key: string): string {
  const definition = tags.find((tag) => tag.key === key);
  return definition === undefined ? key : definition.zh;
}

export function TagPicker({
  value,
  onChange,
  dictionary,
  placeholder = '从标签字典多选',
}: {
  value: string[];
  onChange: (value: string[]) => void;
  dictionary: readonly TagDefinition[];
  placeholder?: string;
}): React.ReactElement {
  const known = new Set(dictionary.map((tag) => tag.key));
  const options = dictionary.map((tag) => ({
    value: tag.key,
    label: `${tag.zh} / ${tag.en}`,
  }));
  const unknown = value.filter((key) => !known.has(key));
  return (
    <Select
      mode="multiple"
      allowClear
      value={value}
      onChange={(next: string[]) => onChange(next)}
      options={options}
      placeholder={placeholder}
      optionFilterProp="label"
      tagRender={({ value: key, closable, onClose }) => {
        const definition = dictionary.find((tag) => tag.key === key);
        return (
          <Tag
            color={definition === undefined ? 'default' : 'geekblue'}
            bordered={definition !== undefined}
            closable={closable}
            onClose={onClose}
            style={{ marginInlineEnd: 4 }}
          >
            {definition === undefined ? `${key}（未登记）` : definition.zh}
          </Tag>
        );
      }}
      notFoundContent={
        <span className="muted">
          字典为空。{unknown.length > 0 ? '已有未登记标签仍会保留。' : '先到“配置 › 标签”登记。'}
        </span>
      }
    />
  );
}
