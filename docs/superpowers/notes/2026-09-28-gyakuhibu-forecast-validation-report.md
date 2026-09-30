# 逆日歩予測 精度検証レポート(権利日: 2026-09-28)

生成日時: 2026-09-29T23:38:12.445Z

## スナップショットA(本命、asof=2026-09-26T0000JST、確報9/24分)

```json
{
  "label": "Snapshot A (final, asof=2026-09-26T0000JST)",
  "n": 93,
  "populationBreakdown": {
    "total": 307,
    "primary": 93,
    "noExcess": 38,
    "specialMultiplier": 176,
    "fetchFailed": 0
  },
  "note": null,
  "quantileCoverage": {
    "p50Coverage": 0.3333333333333333,
    "p90Coverage": 0.7526881720430108
  },
  "pinballLossP50": 0.06405434870601168,
  "pinballLossP90": 0.05173574669653916,
  "occurrenceConfusionMatrix": {
    "truePositive": 59,
    "falsePositive": 4,
    "falseNegative": 26,
    "trueNegative": 4
  },
  "occurrenceRateByBin": {
    "5以上": {
      "n": 53,
      "predictedRate": 0.9811320754716981,
      "actualRate": 0.9433962264150944
    },
    "0〜0.5": {
      "n": 10,
      "predictedRate": 0.2,
      "actualRate": 0.9
    },
    "0.5〜1": {
      "n": 4,
      "predictedRate": 0.5,
      "actualRate": 1
    },
    "融資超過": {
      "n": 18,
      "predictedRate": 0,
      "actualRate": 0.8888888888888888
    },
    "2〜5": {
      "n": 6,
      "predictedRate": 0.8333333333333334,
      "actualRate": 0.6666666666666666
    },
    "1〜2": {
      "n": 2,
      "predictedRate": 1,
      "actualRate": 1
    }
  },
  "statusConfusionMatrix": {
    "safe": {
      "safe": 37,
      "caution": 0,
      "danger": 3,
      "na": 0
    },
    "caution": {
      "safe": 11,
      "caution": 0,
      "danger": 5,
      "na": 0
    },
    "danger": {
      "safe": 0,
      "caution": 0,
      "danger": 2,
      "na": 0
    },
    "na": {
      "safe": 0,
      "caution": 0,
      "danger": 0,
      "na": 35
    }
  },
  "safeMissList": [
    {
      "ticker": "6625",
      "value": 15000,
      "costActual": 20800,
      "fillP50": 0.0020380434782608695,
      "fillP90": 0.0625
    },
    {
      "ticker": "8739",
      "value": 2000,
      "costActual": 2550,
      "fillP50": 0,
      "fillP90": 0
    },
    {
      "ticker": "4008",
      "value": 1000,
      "costActual": 1025,
      "fillP50": 0,
      "fillP90": 0.08203124999999999
    }
  ],
  "binBreakdown": {
    "5以上": {
      "n": 53,
      "p50Coverage": 0.4716981132075472,
      "p90Coverage": 0.9245283018867925,
      "pinballP50": 0.05543472213155115,
      "pinballP90": 0.028484328811472313
    },
    "0〜0.5": {
      "n": 10,
      "p50Coverage": 0.1,
      "p90Coverage": 0.6,
      "pinballP50": 0.07671926595841587,
      "pinballP90": 0.05595501606507297
    },
    "0.5〜1": {
      "n": 4,
      "p50Coverage": 0,
      "p90Coverage": 0.5,
      "pinballP50": 0.15077355653102936,
      "pinballP90": 0.25571987448825684
    },
    "融資超過": {
      "n": 18,
      "p50Coverage": 0.1111111111111111,
      "p90Coverage": 0.2777777777777778,
      "pinballP50": 0.06230631582285979,
      "pinballP90": 0.09146291392384065
    },
    "2〜5": {
      "n": 6,
      "p50Coverage": 0.5,
      "p90Coverage": 1,
      "pinballP50": 0.0645941914445204,
      "pinballP90": 0.011495665667944762
    },
    "1〜2": {
      "n": 2,
      "p50Coverage": 0,
      "p90Coverage": 1,
      "pinballP50": 0.06982421875,
      "pinballP90": 0.002009456264775415
    }
  },
  "baselines": {
    "poolOnlyPinballLossP50": 0.07870224741675971,
    "poolOnlyPinballLossP90": 0.09424003881377387,
    "tickerOnlyPinballLossP50": 0.05146902977727943,
    "tickerOnlyPinballLossP90": 0.022048035801130874,
    "fullFillPinballLossP50": 0.40937097762504515,
    "fullFillPinballLossP90": 0.08187419552500902
  }
}
```

## スナップショットB(参考、asof=2026-09-28T1500JST、確報9/25分)

```json
{
  "label": "Snapshot B (final, asof=2026-09-28T1500JST)",
  "n": 93,
  "populationBreakdown": {
    "total": 307,
    "primary": 93,
    "noExcess": 38,
    "specialMultiplier": 176,
    "fetchFailed": 0
  },
  "note": null,
  "quantileCoverage": {
    "p50Coverage": 0.3333333333333333,
    "p90Coverage": 0.7526881720430108
  },
  "pinballLossP50": 0.06405434870601168,
  "pinballLossP90": 0.05173574669653916,
  "occurrenceConfusionMatrix": {
    "truePositive": 59,
    "falsePositive": 4,
    "falseNegative": 26,
    "trueNegative": 4
  },
  "occurrenceRateByBin": {
    "5以上": {
      "n": 53,
      "predictedRate": 0.9811320754716981,
      "actualRate": 0.9433962264150944
    },
    "0〜0.5": {
      "n": 10,
      "predictedRate": 0.2,
      "actualRate": 0.9
    },
    "0.5〜1": {
      "n": 4,
      "predictedRate": 0.5,
      "actualRate": 1
    },
    "融資超過": {
      "n": 18,
      "predictedRate": 0,
      "actualRate": 0.8888888888888888
    },
    "2〜5": {
      "n": 6,
      "predictedRate": 0.8333333333333334,
      "actualRate": 0.6666666666666666
    },
    "1〜2": {
      "n": 2,
      "predictedRate": 1,
      "actualRate": 1
    }
  },
  "statusConfusionMatrix": {
    "safe": {
      "safe": 37,
      "caution": 0,
      "danger": 3,
      "na": 0
    },
    "caution": {
      "safe": 11,
      "caution": 0,
      "danger": 5,
      "na": 0
    },
    "danger": {
      "safe": 0,
      "caution": 0,
      "danger": 2,
      "na": 0
    },
    "na": {
      "safe": 0,
      "caution": 0,
      "danger": 0,
      "na": 35
    }
  },
  "safeMissList": [
    {
      "ticker": "6625",
      "value": 15000,
      "costActual": 20800,
      "fillP50": 0.0020380434782608695,
      "fillP90": 0.0625
    },
    {
      "ticker": "8739",
      "value": 2000,
      "costActual": 2550,
      "fillP50": 0,
      "fillP90": 0
    },
    {
      "ticker": "4008",
      "value": 1000,
      "costActual": 1025,
      "fillP50": 0,
      "fillP90": 0.08203124999999999
    }
  ],
  "binBreakdown": {
    "5以上": {
      "n": 53,
      "p50Coverage": 0.4716981132075472,
      "p90Coverage": 0.9245283018867925,
      "pinballP50": 0.05543472213155115,
      "pinballP90": 0.028484328811472313
    },
    "0〜0.5": {
      "n": 10,
      "p50Coverage": 0.1,
      "p90Coverage": 0.6,
      "pinballP50": 0.07671926595841587,
      "pinballP90": 0.05595501606507297
    },
    "0.5〜1": {
      "n": 4,
      "p50Coverage": 0,
      "p90Coverage": 0.5,
      "pinballP50": 0.15077355653102936,
      "pinballP90": 0.25571987448825684
    },
    "融資超過": {
      "n": 18,
      "p50Coverage": 0.1111111111111111,
      "p90Coverage": 0.2777777777777778,
      "pinballP50": 0.06230631582285979,
      "pinballP90": 0.09146291392384065
    },
    "2〜5": {
      "n": 6,
      "p50Coverage": 0.5,
      "p90Coverage": 1,
      "pinballP50": 0.0645941914445204,
      "pinballP90": 0.011495665667944762
    },
    "1〜2": {
      "n": 2,
      "p50Coverage": 0,
      "p90Coverage": 1,
      "pinballP50": 0.06982421875,
      "pinballP90": 0.002009456264775415
    }
  },
  "baselines": {
    "poolOnlyPinballLossP50": 0.07870224741675971,
    "poolOnlyPinballLossP90": 0.09424003881377387,
    "tickerOnlyPinballLossP50": 0.05146902977727943,
    "tickerOnlyPinballLossP90": 0.022048035801130874,
    "fullFillPinballLossP50": 0.40937097762504515,
    "fullFillPinballLossP90": 0.08187419552500902
  }
}
```

## スナップショット間で予測statusが入れ替わった銘柄

(該当銘柄なし)

## 注記

- design doc(2026-09-24)はA-final/A-prelim/Bの3本比較を想定していたが、A-prelimはTask 3(旧計画)完了時点で不要と判断され実装されていない。本レポートはA・B(いずれもfinal、別日付の確報)の2本比較として扱う。
- baselines.poolOnlyPinballLoss(P50/P90)・tickerOnlyPinballLoss(P50/P90)は、本命集計内の全サンプルが対応するベースライン配列(プール側/銘柄側)を欠く場合にnullになる(データ不足を意味する正当な値。エラーではない)。