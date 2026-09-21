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
import { YutaiListPage } from './pages/YutaiListPage';
import { YutaiForecastListPage } from './pages/YutaiForecastListPage';
import { YutaiDetailPage } from './pages/YutaiDetailPage';
import { YutaiForecastDetailPage } from './pages/YutaiForecastDetailPage';
import { YutaiTdnetEventsPage } from './pages/YutaiTdnetEventsPage';

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
            <Route path="yutai" element={<YutaiListPage />} />
            <Route path="yutai/forecast" element={<YutaiForecastListPage />} />
            <Route path="yutai/tdnet-events" element={<YutaiTdnetEventsPage />} />
            <Route path="yutai/:ticker" element={<YutaiDetailPage />} />
            <Route path="yutai/:ticker/forecast" element={<YutaiForecastDetailPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PasswordGate>
  </StrictMode>,
);
