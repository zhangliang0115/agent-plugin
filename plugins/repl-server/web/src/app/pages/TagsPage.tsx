/** Tag dictionary page: editable key/zh/en rows saved as a full replacement. */
import { DictionaryEditor } from '../components/DictionaryEditor.tsx';
import { useTagDictionary } from '../components/TagPicker.tsx';

export function TagsPage(): React.ReactElement {
  const dictionary = useTagDictionary();
  return (
    <DictionaryEditor
      endpoint="/tags"
      field="tags"
      noun="标签"
      description="维护标签字典：key 用于存储，中文与 English 用于展示。删除字典项不会清掉已有数据；未登记标签在表单里显示为“未登记”。"
      maxEntries={200}
      sample={{ key: 'db', zh: '数据库', en: 'Database' }}
      onSaved={() => dictionary.reload()}
    />
  );
}
