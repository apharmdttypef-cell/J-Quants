import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { PasswordGate } from './components/PasswordGate';
import { TickerListPage } from './pages/TickerListPage';
import { TickerDetailPage } from './pages/TickerDetailPage';
import { ScreeningPage } from './pages/ScreeningPage';
import { WatchlistPage } from './pages/WatchlistPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PasswordGate>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<TickerListPage />} />
            <Route path="tickers/:ticker" element={<TickerDetailPage />} />
            <Route path="screening" element={<ScreeningPage />} />
            <Route path="watchlist" element={<WatchlistPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PasswordGate>
  </StrictMode>,
);
