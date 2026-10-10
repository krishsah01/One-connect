// SPDX-License-Identifier: Apache-2.0
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import { PairPage } from './pages/PairPage';
import { registerServiceWorker } from './lib/pwa';
import { loadRemoteSession } from './lib/remote';
import './styles.css';
import './phone.css';

const pairing = window.location.pathname === '/pair';
if (!pairing) {
  void loadRemoteSession();
  void registerServiceWorker();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {pairing ? (
      <PairPage />
    ) : (
      <BrowserRouter>
        <App />
      </BrowserRouter>
    )}
  </StrictMode>,
);
