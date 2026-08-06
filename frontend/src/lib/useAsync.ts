import { useEffect, useState } from 'react';

interface AsyncState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
}

// 依存配列が変わるたびに再実行する薄いdata-fetchingフック。
// このアプリの規模でReact QueryのようなライブラリはOverkillなので導入しない。
export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ data: undefined, error: undefined, loading: true });

  // deps is intentionally caller-provided (like useEffect's own array) rather than
  // statically analyzable, so exhaustive-deps can't verify it here.
  // oxlint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    let cancelled = false;
    setState({ data: undefined, error: undefined, loading: true });

    fetcher()
      .then((data) => {
        if (!cancelled) setState({ data, error: undefined, loading: false });
      })
      .catch((error: Error) => {
        if (!cancelled) setState({ data: undefined, error, loading: false });
      });

    return () => {
      cancelled = true;
    };
  }, deps);

  return state;
}
