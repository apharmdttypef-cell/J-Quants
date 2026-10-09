import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import './index.css';
import { Layout } from './components/Layout';
import { PasswordGate } from './components/PasswordGate';
import { RedirectToYutaiDetail } from './components/RedirectToYutaiDetail';
import { TickerDetailPage } from './pages/TickerDetailPage';
import { YutaiListPage } from './pages/YutaiListPage';
import { YutaiDetailPage } from './pages/YutaiDetailPage';
import { YutaiTdnetEventsPage } from './pages/YutaiTdnetEventsPage';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PasswordGate>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Navigate to="/yutai" replace />} />
            <Route path="tickers/:ticker" element={<TickerDetailPage />} />
            <Route path="yutai" element={<YutaiListPage />} />
            {/* 旧「逆日歩予測」一覧。優待クロス一覧に統合した */}
            <Route path="yutai/forecast" element={<Navigate to="/yutai" replace />} />
            <Route path="yutai/tdnet-events" element={<YutaiTdnetEventsPage />} />
            <Route path="yutai/:ticker" element={<YutaiDetailPage />} />
            <Route path="yutai/:ticker/forecast" element={<RedirectToYutaiDetail />} />
            <Route path="*" element={<Navigate to="/yutai" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </PasswordGate>
  </StrictMode>,
);
