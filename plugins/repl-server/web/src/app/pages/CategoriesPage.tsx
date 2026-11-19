/** Category dictionary page: editable key/zh/en rows saved as a full replacement. */
import { useCategoryDictionary } from '../components/CategorySelect.tsx';
import { DictionaryEditor } from '../components/DictionaryEditor.tsx';

export function CategoriesPage(): React.ReactElement {
  const dictionary = useCategoryDictionary();
  return (
    <DictionaryEditor
      endpoint="/categories"
      field="categories"
      noun="分类"
      description="维护分类字典：key 用于存储，中文与 English 用于展示。删除字典项不会清掉已有数据；未登记分类在表单里显示为“未登记”。"
      maxEntries={100}
      sample={{ key: 'database', zh: '数据库', en: 'Database' }}
      onSaved={() => dictionary.reload()}
    />
  );
}
