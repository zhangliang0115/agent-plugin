/** Category dictionary hook plus the single-select used by server/tool forms. */
import { Select, type SelectProps } from 'antd';

import { dictionarySelectOptions, type DictionaryEntry } from '../../lib/dictionary.ts';
import { useDictionaryResource } from './dictionary-resource.ts';

export interface CategoryDictionaryState {
  categories: DictionaryEntry[];
  revision: number;
  loading: boolean;
  reload(): Promise<void>;
}

export function useCategoryDictionary(): CategoryDictionaryState {
  const { entries, revision, loading, reload } = useDictionaryResource(
    '/categories',
    'categories',
  );
  return { categories: entries, revision, loading, reload };
}

export function CategorySelect({
  value,
  onChange,
  dictionary,
  placeholder = '从分类字典选择',
  size,
  style,
}: {
  value?: string;
  onChange?: (value: string) => void;
  dictionary: readonly DictionaryEntry[];
  placeholder?: string;
  size?: SelectProps['size'];
  style?: SelectProps['style'];
}): React.ReactElement {
  return (
    <Select
      size={size}
      style={style}
      allowClear
      showSearch
      optionFilterProp="label"
      value={value === undefined || value === '' ? undefined : value}
      onChange={(next?: string) => onChange?.(next ?? '')}
      options={dictionarySelectOptions(dictionary, value)}
      placeholder={placeholder}
      notFoundContent={<span className="muted">字典为空。先到“配置 › 分类”登记。</span>}
    />
  );
}
