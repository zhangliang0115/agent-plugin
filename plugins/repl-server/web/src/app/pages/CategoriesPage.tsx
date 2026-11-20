/** Category dictionary page: editable key/zh/en rows saved as a full replacement. */
import { useEffect, useState } from 'react';

import { useApi } from '../api.tsx';
import { useCategoryDictionary } from '../components/CategorySelect.tsx';
import { DictionaryEditor } from '../components/DictionaryEditor.tsx';
import { loadDictionaryUsage } from '../../lib/references.ts';
import { isLockedCategoryKey } from '../../lib/tags.ts';

export function CategoriesPage(): React.ReactElement {
  const api = useApi();
  const dictionary = useCategoryDictionary();
  /** Tool counts shown in the 关联 column; refreshed with the page. */
  const [usageCounts, setUsageCounts] = useState<ReadonlyMap<string, number> | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadDictionaryUsage(api)
      .then((usage) => {
        if (cancelled) return;
        setUsageCounts(
          new Map([...usage.categories].map(([key, entry]) => [key, entry.tools.length])),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [api]);

  async function categoryUsage(key: string) {
    const usage = await loadDictionaryUsage(api);
    return usage.categories.get(key) ?? { servers: [], tools: [] };
  }

  return (
    <DictionaryEditor
      endpoint="/categories"
      field="categories"
      noun="分类"
      description="维护分类字典：key 用于存储，中文与 English 用于展示。系统内置分类不可修改或删除；删除字典项不会清掉已有数据；未登记分类在表单里显示为“未登记”。"
      maxEntries={100}
      sample={{ key: 'database', zh: '数据库', en: 'Database' }}
      isLockedKey={isLockedCategoryKey}
      showUsage={{ get: categoryUsage, counts: usageCounts }}
      onSaved={() => dictionary.reload()}
    />
  );
}
