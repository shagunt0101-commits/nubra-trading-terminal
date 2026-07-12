import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { MarketDataProvider } from './context/MarketDataContext';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MarketDataProvider>
      <App />
    </MarketDataProvider>
  </StrictMode>,
);

