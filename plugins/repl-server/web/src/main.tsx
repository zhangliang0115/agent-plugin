/** React entry for the admin UI. */
import { createRoot } from 'react-dom/client';

import { ApiProvider } from './app/api.tsx';
import { App } from './app/App.tsx';

const root = document.querySelector<HTMLElement>('#app');
if (root === null) throw new Error('repl-server admin: #app is missing');

createRoot(root).render(
  <ApiProvider>
    <App />
  </ApiProvider>,
);
