import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App, type RouterMode } from './App';
import { createQueryClient } from './api/queries';
import './styles/index.css';

function routerMode(demo: boolean): RouterMode {
  const requested = import.meta.env.VITE_DEMO_ROUTER;
  if (!demo) return 'browser';
  return requested === 'browser' || requested === 'hash' ? requested : 'memory';
}

async function boot() {
  const demo = import.meta.env.MODE === 'demo';
  if (demo) {
    // self-contained build for reviewing the UI without a server (see src/demo)
    const { installDemo } = await import('./demo/install');
    installDemo();
  }
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  createRoot(root).render(
    <StrictMode>
      <App queryClient={createQueryClient()} router={routerMode(demo)} />
    </StrictMode>,
  );
}

void boot();
