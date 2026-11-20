/** Tag dictionary page: editable key/zh/en rows saved as a full replacement. */
import { useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { DictionaryEditor } from '../components/DictionaryEditor.tsx';
import { useTagDictionary } from '../components/TagPicker.tsx';
import type { DictionaryEntry } from '../../lib/dictionary.ts';
import { loadDictionaryUsage } from '../../lib/references.ts';
import { isLockedTagKey, unusedTagKeys } from '../../lib/tags.ts';

export function TagsPage(): React.ReactElement {
  const api = useApi();
  const dictionary = useTagDictionary();
  /** Tool counts shown in the 关联 column; refreshed with the page. */
  const [usageCounts, setUsageCounts] = useState<ReadonlyMap<string, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadDictionaryUsage(api)
      .then((usage) => {
        if (cancelled) return;
        setUsageCounts(new Map([...usage.tags].map(([key, entry]) => [key, entry.tools.length])));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  /** Tags stored on any server or tool count as referenced, even if unregistered. */
  async function findUnused(rows: readonly DictionaryEntry[]): Promise<DictionaryEntry[]> {
    const usage = await loadDictionaryUsage(api);
    const unused = new Set(unusedTagKeys(rows, new Set(usage.tags.keys())));
    return rows.filter((row) => unused.has(row.key.trim().toLowerCase()));
  }

  async function tagUsage(key: string) {
    const usage = await loadDictionaryUsage(api);
    return usage.tags.get(key) ?? { servers: [], tools: [] };
  }

  return (
    <DictionaryEditor
      endpoint="/tags"
      field="tags"
      noun="标签"
      description="维护标签字典：key 用于存储，中文与 English 用于展示。系统内置标签（预置字典项与 env.*）不可修改或删除；「清理未引用」只删除没有被任何 server 或工具使用的标签。删除字典项不会清掉已有数据。"
      maxEntries={200}
      sample={{ key: 'db', zh: '数据库', en: 'Database' }}
      isLockedKey={isLockedTagKey}
      prune={{ label: '清理未引用', findUnused }}
      showUsage={{ get: tagUsage, counts: usageCounts }}
      onSaved={() => dictionary.reload()}
    />
  );
}
