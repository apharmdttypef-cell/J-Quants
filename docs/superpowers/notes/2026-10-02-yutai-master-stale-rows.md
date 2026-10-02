# 優待マスタに残った6銘柄の調査(kabuyutai.com の一覧から消えた銘柄)

調査日: 2026-10-02

## 発見の経緯

Task 12 手順2(`yutai-master-sync-batch` の実行)の検証で、1,642行のうち **6行に `detailUrl` が入らなかった**。
master-sync は「一覧ページで見つかった銘柄を upsert」する作りなので、サイト側から消えた銘柄は
更新されずに古い値のまま残る。その結果これらは `yutai-detail-sync-batch` でも
`detailUrl` 無しとしてスキップされ、`requiredShares` も永久に入らない。

## 調査結果: 6銘柄すべて現時点で優待クロスの対象外

| ticker | 会社名 | 判定 | 根拠 |
|---|---|---|---|
| 1909 | 日本ドライケミカル | **上場廃止** | TOB(TCG2511 = ALSOK + カーライル)後の株式併合で 2026-09-14 上場廃止。8/24〜9/13 整理銘柄。JQuantsStockPrices も 2026-09-11 で停止しており整合する |
| 6044 | 三機サービス | **優待廃止** | kabuyutai.com の「株主優待廃止を発表した企業一覧」に掲載(7/15発表、最終権利確定月5月) |
| 3676 | デジタルハーツホールディングス | **優待廃止** | 2026-08-06 発表。MBO に伴う公開買付け成立を条件に 2027年3月期から廃止、2026年3月分が最後 |
| 7490 | 日新商事 | **優待廃止** | kabuyutai.com の廃止一覧に掲載(5/11発表、最終権利確定月3月) |
| 5698 | エンビプロ・ホールディングス | **優待廃止** | 2026年6月分を最後に廃止。以後は配当による還元に集約 |
| 6522 | アスタリスク | **一回限りの記念優待** | 設立20周年記念優待。2026-08-31 基準の株主へ株数不問で QUOカードPay 500円。恒常的な優待ではないため一覧から消えた |

5698 以外の4銘柄は株価データが 2026-10-02 まであり上場中。1909 のみ上場廃止。

## 判明した重要な点1: 「汚染された unitShares」は一部が実は正しい値だった

手順2の検証で `unitShares != 100` が3件(5698=400、3676=500、7490=300)出たため、当初これを
廃止した `estimateRequiredShares`(`minInvestment ÷ 株価` を100株単位に丸める)の残骸=汚染と
判断したが、調査すると**実際の必要株数と一致していた**。

- 3676 デジタルハーツHD: 優待は「**500株**以上で QUOカード1万円分」 → 500 は正しい
- 5698 エンビプロ・HD: 優待は「**400株**以上を1年以上保有で QUOカード2,000円分」 → 400 も正しい

推定器は、サイトが `minInvestment` を算出した時点から株価が動いていなければ正しい値を復元する。
つまり**不正確というより不安定**で、同じ銘柄が株価変動で別の答えになるのが問題だった
(第一興商では 200 ではなく別の値になり得た)。「常に誤り」ではない点は記録しておく価値がある。

ただし `unitShares` という**フィールド名の意味としては誤り**であることは変わらない
(単元株数は2018年10月以降 内国株で100株固定)。必要株数は `requiredShares` が持つべき値。

## 判明した重要な点2: 5698 は継続保有1年以上が条件だった

「400株以上を**1年以上継続保有**」なので、`crossEligible` は `ng`(1回のクロスでは取れない)に
なるべき銘柄。マスタには継続保有条件が入っていなかった — 個別ページを取得する前なので当然だが、
この機能が解こうとしている問題の実例として残しておく。

## TDnet 監視では検知できていない

`JQuantsYutaiTdnetEvent` を6銘柄で検索したが**0件**。ただしこれは廃止の否定にならない:
`yutai-tdnet-watch-batch` は週次・9日遡りで、稼働開始は2026年9月下旬。
5/11・7/15・8/6 の廃止開示はいずれも観測範囲の外だった。

**TDnet 監視は稼働開始より前の開示を遡れない**という構造的な限界で、初回の全件取得と
その検証を人が見る必要がある理由のひとつ。

## 対応

6行は削除した(優待クロスの対象として存在しないため、一覧に現在のものとして並ぶのを避ける)。
削除前の内容はこのノートの表と、この時点の `JQuantsYutaiMaster` のスキャン結果に残っている。

6522 アスタリスクは記念優待が再度行われる可能性がある。その場合 kabuyutai.com の一覧に再掲載され、
`yutai-master-sync-batch` が自然に拾い直す(削除は恒久的な除外ではない)。

## 残る運用上の示唆

master-sync は「サイトから消えた銘柄」を検出しない(upsert のみ)。同じことは今後も起きる。
検出するには、master-sync 実行後に「`detailUrl` が無い行」を数えるのが最も簡単で、
今回それが実際に効いた。Task 12 手順2の検証手順にこの観点が入っているのは維持する価値がある。

## 削除した6行の完全な内容(復元用)

削除は 2026-10-02 に実施。復元するにはこのJSONの各要素を `JQuantsYutaiMaster` に PutItem すればよい。
ただし復元しても `yutai-master-sync-batch` は kabuyutai.com の一覧に無い銘柄を更新しないため、
値は削除時点のまま古いままになる(`conditionCheckedAt` も入らないので detail-sync もスキップする)。

```json
[
  {
    "closePrice": 3700,
    "companyName": "日本ドライケミカル",
    "content": "オリジナルQUOカード（1,000円相当～）など",
    "days": 1,
    "maxGyakuhibu": 2960,
    "maxRate": 29.6,
    "rightsMonths": [
      9
    ],
    "riskStatus": "danger",
    "ticker": "1909",
    "unitShares": 100,
    "value": 1000
  },
  {
    "closePrice": 1867,
    "companyName": "三機サービス",
    "content": "QUOカード（500円相当～）",
    "days": 1,
    "maxGyakuhibu": 1520,
    "maxRate": 15.2,
    "minInvestment": 190100,
    "rightsMonths": [
      5
    ],
    "riskStatus": "danger",
    "ticker": "6044",
    "unitShares": 100,
    "value": 500
  },
  {
    "closePrice": 1051,
    "companyName": "デジタルハーツホールディングス",
    "content": "QUOカード（10,000円相当）",
    "days": 1,
    "maxGyakuhibu": 4400,
    "maxRate": 8.8,
    "minInvestment": 529000,
    "rightsMonths": [
      3
    ],
    "riskStatus": "safe",
    "ticker": "3676",
    "unitShares": 500,
    "value": 10000
  },
  {
    "closePrice": 2192,
    "companyName": "日新商事",
    "content": "カタログギフト（3,000円相当～）",
    "days": 1,
    "maxGyakuhibu": 5280,
    "maxRate": 17.6,
    "minInvestment": 656400,
    "rightsMonths": [
      3
    ],
    "riskStatus": "danger",
    "ticker": "7490",
    "unitShares": 300,
    "value": 3000
  },
  {
    "closePrice": 703,
    "companyName": "エンビプロ・ホールディングス",
    "content": "QUOカード（2,000円相当）",
    "days": 1,
    "maxGyakuhibu": 2400,
    "maxRate": 6,
    "minInvestment": 295600,
    "rightsMonths": [
      6
    ],
    "riskStatus": "danger",
    "ticker": "5698",
    "unitShares": 400,
    "value": 2000
  },
  {
    "closePrice": 1249,
    "companyName": "アスタリスク",
    "content": "QUOカードPay（500円相当）",
    "days": 1,
    "maxGyakuhibu": 1040,
    "maxRate": 10.4,
    "minInvestment": 150000,
    "rightsMonths": [
      8
    ],
    "riskStatus": "danger",
    "ticker": "6522",
    "unitShares": 100,
    "value": 500
  }
]
```
