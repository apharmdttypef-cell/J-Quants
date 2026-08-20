# 無料公開TDnetサイトの実データ調査結果

`curl -A "Mozilla/5.0 ..." https://www.release.tdnet.info/inbs/I_main_00.html` で実際にHTMLを取得して判明した内容。WebFetchツールでは403になったが、ブラウザらしいUser-Agentを付けた素のcurl GETでは200が返る(taisyaku.jp・kabuyutai.comと同様のパターン)。

## トップページ(`I_main_00.html`)の構造

`<select id="day-selector">`に、直近31日分の日付が`<option value="I_list_001_YYYYMMDD.html">YYYY/MM/DD(曜)</option>`という形式で並んでいる(実際に2026-07-21〜2026-08-20の31日分を確認)。本体は`<iframe id="main_list" src="I_list_001_YYYYMMDD.html">`で当日分の一覧を読み込んでいるだけなので、**JS/dropdown操作は不要で、日付ごとの一覧ページURLを直接構築してGETすればよい**。

URLパターン: `https://www.release.tdnet.info/inbs/I_list_00{page}_{YYYYMMDD}.html`(`{page}`は3桁ゼロ埋め、1ページ目は`001`)。

## 日別一覧ページ(`I_list_001_YYYYMMDD.html`)の構造

ページ内に「1～100件／全149件」のような件数表示があり、1ページ最大100件、100件を超える日はページ2以降(`I_list_002_YYYYMMDD.html`等)に続く。ページ内の遷移リンクも同じファイル名パターンなので、件数表示から総ページ数を計算するか、次ページリンクの有無を辿るかで全件取得できる。

開示1件が1行(`<tr>`)で、以下の構造:

```html
<tr>
<td class="oddnew-L kjTime" noWrap>18:15</td>
<td class="oddnew-M kjCode" noWrap>24670</td>
<td class="oddnew-M kjName" noWrap>ＶＬＣセキュリティ   </td>
<td class="oddnew-M kjTitle" align="left"><a href="140120260819523323.pdf" target="_blank">投資有価証券売却損（特別損失）の計上に関するお知らせ</a></td>
<td class="oddnew-M kjXbrl" noWrap align="center"> </td>
<td class="oddnew-M kjPlace" noWrap align="left">名                           </td>
<td class="oddnew-R kjHistroy" align="left">　　　　　</td>
</tr>
```

`class`名にそれぞれ`kjTime`(時刻)・`kjCode`(証券コード)・`kjName`(会社名、全角スペースでパディングあり)・`kjTitle`(開示タイトル、`<a>`のテキスト部分)が付いており、クラス名で機械的に抽出できる。行の背景色を交互にするため`oddnew-*`/`evennew-*`とクラス名が変わる点に注意(セレクタは`kjTime`等の共通クラスの方で拾う)。

## 証券コードの桁数について(要検証)

`kjCode`は`24670`のように**5桁**で出現する(J-Quants等で使う4桁コード「2467」+末尾の区分数字と推定、多くの銘柄で末尾は普通株を表す`0`と思われる)。`JQuantsYutaiMaster`のticker(4桁)と突き合わせるには、5桁→4桁への変換ルール(先頭4桁を取る、または末尾`0`を除去する等)を実装時に複数の実例で検証してから確定する。

## キーワードフィルタリングの方針

`kjTitle`のテキストに対し、優待関連のキーワード(例:「株主優待」を含む)でフィルタする想定。実際の開示タイトルには「株主優待制度の新設に関するお知らせ」「株主優待制度の一部変更に関するお知らせ」「株主優待制度の廃止に関するお知らせ」のような表記が使われることが一般的に知られている(このサンプル取得時点では優待関連の開示は含まれていなかったため、実例での確認は別途必要)。

## まだ確認できていないこと

- 実際に「株主優待」関連の開示タイトルの実例(サンプル取得時点で該当する開示が無かったため、正確な表記ゆれの確認ができていない)。
- `kjCode`5桁→4桁変換の正確なルール(複数の実銘柄で確認する必要がある)。
- 連続アクセス時のレート制限・Bot対策の有無(今回は1回のGETのみで確認、taisyaku.jp同様に節度あるアクセス間隔を置く前提で実装する)。
- 週次バッチが「前回実行からの差分日」だけを対象にするか、常に直近7日分をチェックするか(冪等性を考えると後者が単純。実装時に決定)。
