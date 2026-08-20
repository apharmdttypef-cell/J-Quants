# kabuyutai.com 月別一覧ページの実データ調査結果

`curl -A "Mozilla/5.0 ..." https://www.kabuyutai.com/yutai/august.html` で実際にHTMLを取得して判明した内容。taisyaku.jpと異なりBot対策・CSRF・セッションCookieは無く、素のGETで200が返る(実装時にヘッダー等の再検証は必要だが、既知の障壁は無い)。

## URLパターン

`https://www.kabuyutai.com/yutai/<month>.html`(1ページ目)、2ページ目以降は`<month><n>.html`(例: `august2.html`、`august3.html`)。`<month>`は英語月名の小文字(`january`〜`december`)。

## ページネーション

**月ごとにページ数が異なり、事前に固定件数を仮定できない**(実測: 8月は7ページ)。ページ下部に以下の構造で現れる:

```html
<div class="pagination"><a href ="july.html">前月</a><span class="pageNow">1</span><a href="august2.html">2</a><a href="august3.html">3</a><a href="august4.html">4</a><a href="august5.html">5</a><span class="blankNum">…</span><a href="august7.html">7</a><a href="august2.html">　>　</a></div>
```

`<span class="pageNow">`が現在ページ、それ以外の`<a href="...">`が他ページへのリンク。最終ページ番号を機械的に知るには、この`pagination`ブロック内の`<a href="{month}{n}.html">`から数値`n`を全て抽出し最大値を取る(次ページへの「>」リンクは`{month}2.html`固定で紛らわしいため、数字部分のみのリンクを対象にする)か、単純に「次ページへの`>`リンクが無くなるまで順に辿る」方式のどちらかで実装する。後者の方が正規表現の誤読リスクが低く安全。

## 1ページあたりの掲載件数と銘柄ブロックの区切り

1ページ20銘柄。各銘柄は以下のHTMLコメントで挟まれたブロックとして現れる(8月1ページ目で20回ずつ出現、確認済み):

```html
<!-- ▼ランキング_ブロック -->
...(1銘柄分)...
<!-- ▲ランキング_ブロック -->
```

**この2つのコメントでページ全体をブロックに分割してから、ブロックごとに以下の項目を正規表現で抽出するのが安全**(ページ全体に対して`kigyoumei`等のクラス名でgrepすると、ランキングブロック外に紛れ込む同名クラスにマッチする恐れがある。実測でも`kigyoumei`はブロック内20件+ブロック外1件で計21件ヒットした)。

## 1銘柄分のブロックの実例(コシダカホールディングス・2157、8月1ページ目より抜粋)

```html
<div class="table_tr">
<p><a href="https://www.kabuyutai.com/kobetu/koshidakaholdings.html"><img src="https://www.kabuyutai.com/img/yutai/2157.jpg" alt="コシダカホールディングス" loading="lazy"></a><span><img src="https://www.kabuyutai.com/img/cmn_star40.png" width="153" height="28" alt=""></span></p>
<div class="table_tr_inner">
<div class="table_tr_info">
<div><div class="chouki tooltip">長期優遇あり<div class="tip_des">一定期間、株式を継続保有すると優待内容が優遇される銘柄です</div></div></div>
<p><a href="https://www.kabuyutai.com/kobetu/koshidakaholdings.html" class="kigyoumei">コシダカホールディングス</a>（2157）</p>


<p>【優待内容】「カラオケまねきねこ」のほか、グループ店舗で使える優待利用割引券（2,000円相当～）</p>
<p>【権利確定月】<span class="tousi_price">2月・8月</span></p>
<p>【必要投資金額】<span class="tousi_price">102,200円</span></p>
<p class="taishaku">【信用貸借区分】<b>貸借</b></p>
<p>【優待利回り】<span class="tousi_price">3.91％</span></p>
<p>【予想配当利回り】<span class="tousi_price">2.73％</span></p>

 </div>
 <div class="table_tr_rimawari">
<div>
 <p><span class="rima_tit">【総合利回り】</span><span class="rima_num">6.64％</span></p>
<p class="btn gaibu arrow"><a href="...">最新株価</a></p>
 </div>
 </div>
 </div>
</div>
```

## 抽出すべき項目と正規表現の当たり

- **銘柄コード + 企業名**: `<p><a href="[^"]+" class="kigyoumei">([^<]+)</a>（(\d{4})）</p>` — グループ1が企業名、グループ2が4桁コード(全角括弧`（）`であることに注意。半角`()`ではない)
- **優待内容**: `【優待内容】([^<]+)` — `<p>【優待内容】...</p>`の中身。末尾に「など」が付くこともある(地域新聞社の例)
- **権利確定月**: `【権利確定月】<span class="tousi_price">([^<]+)</span>` — 中身は「2月・8月」のような`月`区切り文字列。`・`で分割し、各要素から`月`を除いて数値化する(例: `"2月・8月"` → `[2, 8]`。単月なら`"8月"` → `[8]`)
- **優待価値(value)**: 優待内容の文字列中に含まれる`(?:（|\()([\d,]+)円相当`(全角`（`と半角`(`の両方があり得るため両対応。実例はすべて全角`（`だった)。カンマを除去して数値化。マッチしない場合はその銘柄をスキップしログに警告。

## まだ確認できていないこと

- 銘柄コードでの直接検索機能(`/tool/`ページ)が実際に使えるか、使えるならどのようなURL/パラメータか。`yutai-tdnet-watch-batch`実装時に確認する。
- 12ヶ月全体の総ページ数・総銘柄数の実測(8月だけで7ページ=最大140銘柄。他の月も同様に数ページ〜10ページ弱と見込まれ、当初想定していた「全体で約24ページ」は過小評価だった。正確な数は実装時に全月を実際に辿って確認する)。
- レート制限・Bot対策の有無(今回はcurlで1回GETしただけで、連続アクセス時の挙動は未検証)。
