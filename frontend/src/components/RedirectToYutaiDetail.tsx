import { Navigate, useParams } from 'react-router-dom';

// 旧「逆日歩予測」の銘柄詳細(/yutai/:ticker/forecast)は銘柄詳細(/yutai/:ticker)に統合した。
// ブックマーク等のために旧URLは残し、統合後の詳細へ送る。
export function RedirectToYutaiDetail() {
  const { ticker } = useParams<{ ticker: string }>();
  return <Navigate to={`/yutai/${ticker ?? ''}`} replace />;
}
