/** Temporary shell for pages that are still being migrated to React. */
import { Empty } from 'antd';

import { PageHeader } from '../components/common.tsx';

export function Placeholder({ title }: { title: string }): React.ReactElement {
  return (
    <div className="page">
      <PageHeader title={title} description="该分区正在迁移到 React + Ant Design。" />
      <Empty description="迁移中" />
    </div>
  );
}
