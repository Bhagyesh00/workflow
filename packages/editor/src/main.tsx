import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createQueryClient } from './api/queries';
import './styles/index.css';

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
      <App queryClient={createQueryClient()} hash={demo} />
    </StrictMode>,
  );
}

void boot();
