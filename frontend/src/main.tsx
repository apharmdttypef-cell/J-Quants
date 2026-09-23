import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { PasswordGate } from './components/PasswordGate';
import { TickerDetailPage } from './pages/TickerDetailPage';
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
            <Route index element={<Navigate to="/yutai/forecast" replace />} />
            <Route path="tickers/:ticker" element={<TickerDetailPage />} />
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
