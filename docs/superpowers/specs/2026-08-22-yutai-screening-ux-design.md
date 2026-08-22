# 株主優待ページ UXリッチ化 設計書

`YutaiListPage`(優待クロス スクリーニング一覧)・`YutaiDetailPage`(個別銘柄詳細)の2画面を対象に、既存デザイン(暖色系トークン・Zen Kaku Gothic New/Inter/JetBrains Mono・risk-badge配色)は維持したまま、ヘッドレスなOSSライブラリで機能面をリッチにする。

## 背景・目的

`frontend/`はTailwindやUIキットを使わず、`index.css`に手書きのデザイントークン・コンポーネントクラス(`.data-table`/`.card`/`.risk-badge`等)を持つ小規模なReactアプリ。見た目の作り込み自体は既に一定水準にあるため、「リッチにしたい」は世界観の刷新ではなく、インタラクション面(ソート・プレビューの堅牢化)の強化と確認した。既存デザインを壊さないよう、見た目を持たないヘッドレスライブラリのみを追加する。

## スコープ

**含む**:
- `YutaiListPage`の一覧テーブルへの列ソート追加(`@tanstack/react-table`)
- `YutaiDetailPage`の逆日歩実績プレビューを自前のhoverポップアップ実装から`@radix-ui/react-hover-card`へ置き換え

**含まない**:
- Tailwind/shadcn等の見た目込みUIキットの導入(既存デザイントークンを維持する方針のため)
- 一覧のページネーション・仮想スクロール・列表示切替・行展開(現状の件数規模では不要と判断。将来件数が増えたら別途検討)
- サーバー側のフィルタ・ソートロジックの変更(`GET /yutai`のクエリパラメータ・レスポンス形状はそのまま)
- アニメーションライブラリ(framer-motion等)の追加(RadixのCSS `data-state`駆動アニメーションで十分と判断)

## 依存関係

`frontend/package.json`に追加:
- `@tanstack/react-table` — ヘッドレスなテーブルロジック(ソートのみ使用)
- `@radix-ui/react-hover-card` — hoverでリッチなプレビューを出すためのアクセシブルなプリミティブ

どちらも見た目を持たないため、既存の`.data-table`/`.gyakuhibu-tooltip`等のCSSクラスをそのまま流用できる。

## コンポーネント詳細

### `frontend/src/pages/YutaiListPage.tsx`

現状は`listState.data.tickers.map(...)`で`<tr>`を直接描画しておりソート不可。`useReactTable({ data, columns, getCoreRowModel, getSortedRowModel })`に置き換える。

列定義(`ColumnDef<YutaiListItem>[]`):
- 銘柄: `item.companyName ?? item.ticker`でソート
- 優待内容: `item.content`でソート
- 優待価値: `item.value`(数値)でソート
- 権利日: `item.rightsDate`(文字列日付、`null`は末尾に来るようカスタム比較)でソート
- リスク: `riskStatus`をそのままソートするとアルファベット順(danger/na/safe)になり意味がないため、`{ danger: 0, safe: 1, na: 2 }`のランクで比較するカスタム`sortingFn`を用意する

レンダリングは`table.getHeaderGroups()`/`table.getRowModel().rows`から組み立て、`<table className="data-table">`など既存のクラス名・DOM構造(1列目`textAlign: left`、数値列`num`クラス等)はそのまま維持する。ヘッダーは`<th onClick={header.column.getToggleSortingHandler()}>`とし、`column.getIsSorted()`の値に応じて`▲`/`▼`を見出し末尾に表示する(絵文字での状態表現は`disclaimer-banner`の`⚠️`等、既存コードの流儀に合わせる)。

日付範囲・キーワード・リスクのフィルタ(`filter-bar`)は現状通りサーバーサイド(API呼び出し)のまま変更しない。TanStack Tableはこの画面では取得済み配列の並び替えのみに使う。

### `frontend/src/pages/YutaiDetailPage.tsx`

現状の`triggerRef`+`useState<tooltipStyle>`+`onMouseEnter`で`getBoundingClientRect()`を手計算する実装を削除し、`HoverCard.Root`/`HoverCard.Trigger`/`HoverCard.Portal`/`HoverCard.Content`に置き換える。

- `HoverCard.Trigger asChild`で既存の`<div className="gyakuhibu-hover">`をラップする
- `HoverCard.Content className="gyakuhibu-tooltip" side="bottom" sideOffset={8}`とし、位置計算・画面端の衝突回避はRadixに任せる(現状の`Math.min(rect.left, window.innerWidth - 340)`という簡易実装を撤去)
- 中身(実績逆日歩テーブル、`data.rightsHistory`のmap)はそのまま`Content`内に移す
- `index.css`の`.gyakuhibu-tooltip`から`position: fixed`を削除(Radixの`Portal`+内部的な`position`管理に委ねる)し、`[data-state="open"]`/`[data-state="closed"]`にfade+わずかなslideのCSS `@keyframes`を追加する

副次効果として、フォーカス(キーボード操作)でも開くようになる。これはRadixのプリミティブに乗り換えた結果として自然に得られるものであり、追加のスコープとして作業するわけではない。

## テスト方針

`frontend/`には現状テストフレームワークが未導入(vitest/jest等なし)。本変更でも新規導入はスコープ外とし、`npm run dev`でブラウザ上の実際の挙動(ソート・hoverカードの表示位置/アニメーション/フォーカス開閉)を目視確認する。`npx tsc -b`の型チェックと`oxlint`は既存スクリプト通り実行する。
