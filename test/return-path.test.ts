// フロントの純関数(ログイン後の戻り先の検証)をルートのjestで検証する。
// フロントには単体テスト基盤が無いが、オープンリダイレクト対策は落とせないため。
import { safeReturnPath } from '../frontend/src/lib/return-path';

test('keeps same-origin relative paths, including query and hash', () => {
  expect(safeReturnPath('/yutai/2282')).toBe('/yutai/2282');
  expect(safeReturnPath('/yutai?rightsDateFrom=2026-10-01')).toBe('/yutai?rightsDateFrom=2026-10-01');
  expect(safeReturnPath('/yutai#top')).toBe('/yutai#top');
  expect(safeReturnPath('/')).toBe('/');
});

test('falls back to / for anything that could leave the site (open redirect)', () => {
  for (const unsafe of [
    '//evil.example',
    '//evil.example/yutai',
    'https://evil.example',
    'http://localhost:5173/yutai',
    'javascript:alert(1)',
    '/\\evil.example', // ブラウザは\を/と同じに扱うため、//evil.example と同じになる
    '/\tevil', // 制御文字
    'yutai/2282', // 先頭が / でない
    '',
  ]) {
    expect(safeReturnPath(unsafe)).toBe('/');
  }
});

test('falls back to / for non-string state', () => {
  expect(safeReturnPath(undefined)).toBe('/');
  expect(safeReturnPath(null)).toBe('/');
  expect(safeReturnPath({ returnTo: '/yutai' })).toBe('/');
  expect(safeReturnPath(42)).toBe('/');
});
