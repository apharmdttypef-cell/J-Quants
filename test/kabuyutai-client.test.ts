// Set environment variable to avoid long timeouts during testing
process.env.KABUYUTAI_REQUEST_INTERVAL_MS = '0';

const mockFetch = jest.fn();

beforeEach(() => {
  mockFetch.mockReset();
  (global as unknown as { fetch: typeof mockFetch }).fetch = mockFetch;
});

import { parseListPage, fetchMonthListings, fetchAllListings, findTicker } from '../lambda/shared/kabuyutai-client';

// docs/superpowers/notes/2026-08-20-kabuyutai-list-page-format.md で確認した実データの
// 抜粋(コシダカホールディングス・2157、地域新聞社・2164)を1ページ2銘柄分の断片として使う。
const SAMPLE_PAGE_HTML = `
<div class="pagination"><a href ="july.html">前月</a><span class="pageNow">1</span><a href="august2.html">2</a><a href="august3.html">3</a></div>
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="https://www.kabuyutai.com/kobetu/koshidakaholdings.html"><img src="..." alt="コシダカホールディングス" loading="lazy"></a></p>
<div class="table_tr_inner">
<div class="table_tr_info">
<p><a href="https://www.kabuyutai.com/kobetu/koshidakaholdings.html" class="kigyoumei">コシダカホールディングス</a>（2157）</p>
<p>【優待内容】「カラオケまねきねこ」のほか、グループ店舗で使える優待利用割引券（2,000円相当～）</p>
<p>【権利確定月】<span class="tousi_price">2月・8月</span></p>
<p>【必要投資金額】<span class="tousi_price">102,200円</span></p>
</div>
</div>
</div>
<!-- ▲ランキング_ブロック -->
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="https://www.kabuyutai.com/kobetu/chiikinews.html"><img src="..." alt="地域新聞社" loading="lazy"></a></p>
<div class="table_tr_inner">
<div class="table_tr_info">
<p><a href="https://www.kabuyutai.com/kobetu/chiikinews.html" class="kigyoumei">地域新聞社</a>（2164）</p>
<p>【優待内容】自社ECサイト「ちいきの逸品」で使える優待買物割引券（9,000円相当～）など</p>
<p>【権利確定月】<span class="tousi_price">2月・8月</span></p>
<p>【必要投資金額】<span class="tousi_price">8,512円</span></p>
</div>
</div>
</div>
<!-- ▲ランキング_ブロック -->
`;

describe('parseListPage', () => {
  test('extracts ticker/companyName/content/rightsMonths/value from real-shaped HTML blocks', () => {
    const entries = parseListPage(SAMPLE_PAGE_HTML);

    expect(entries).toEqual([
      {
        ticker: '2157',
        companyName: 'コシダカホールディングス',
        content: '「カラオケまねきねこ」のほか、グループ店舗で使える優待利用割引券（2,000円相当～）',
        rightsMonths: [2, 8],
        value: 2000,
        minInvestment: 102200,
      },
      {
        ticker: '2164',
        companyName: '地域新聞社',
        content: '自社ECサイト「ちいきの逸品」で使える優待買物割引券（9,000円相当～）など',
        rightsMonths: [2, 8],
        value: 9000,
        minInvestment: 8512,
      },
    ]);
  });

  test('returns value: undefined when the content text has no "円相当" pattern', () => {
    const html = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="x" class="kigyoumei">テスト企業</a>（1111）</p>
<p>【優待内容】特典あり</p>
<p>【権利確定月】<span class="tousi_price">3月</span></p>
</div>
<!-- ▲ランキング_ブロック -->
`;
    const entries = parseListPage(html);
    expect(entries).toEqual([
      {
        ticker: '1111',
        companyName: 'テスト企業',
        content: '特典あり',
        rightsMonths: [3],
        value: undefined,
        minInvestment: undefined,
      },
    ]);
  });

  test('parses a single rights month (no "・" separator)', () => {
    const html = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="x" class="kigyoumei">単月企業</a>（3333）</p>
<p>【優待内容】QUOカード（500円相当～）</p>
<p>【権利確定月】<span class="tousi_price">8月</span></p>
</div>
<!-- ▲ランキング_ブロック -->
`;
    expect(parseListPage(html)).toEqual([
      {
        ticker: '3333',
        companyName: '単月企業',
        content: 'QUOカード（500円相当～）',
        rightsMonths: [8],
        value: 500,
        minInvestment: undefined,
      },
    ]);
  });

  test('estimates value from 必要投資金額×優待利回り when content has no "円相当" pattern (ticket-count-based benefits like theme park passes)', () => {
    const html = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="x" class="kigyoumei">オリエンタルランド</a>（4661）</p>
<p>【優待内容】1日パスポート券（1枚～）</p>
<p>【権利確定月】<span class="tousi_price">3月・9月</span></p>
<p>【必要投資金額】<span class="tousi_price">303,900円</span></p>
<p>【優待利回り】<span class="tousi_price">2.59％</span></p>
</div>
<!-- ▲ランキング_ブロック -->
`;
    // 303,900円 × 2.59% = 7,871.01 → 7,871円(個別ページ記載の「7,900円相当」に近い近似値)。
    expect(parseListPage(html)).toEqual([
      {
        ticker: '4661',
        companyName: 'オリエンタルランド',
        content: '1日パスポート券（1枚～）',
        rightsMonths: [3, 9],
        value: 7871,
        minInvestment: 303900,
      },
    ]);
  });

  test('prefers the direct "円相当" value over the yield-based estimate when both are available', () => {
    const html = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="x" class="kigyoumei">直接記載企業</a>（7777）</p>
<p>【優待内容】QUOカード（1,000円相当～）</p>
<p>【権利確定月】<span class="tousi_price">3月</span></p>
<p>【必要投資金額】<span class="tousi_price">468,200円</span></p>
<p>【優待利回り】<span class="tousi_price">0.42％</span></p>
</div>
<!-- ▲ランキング_ブロック -->
`;
    // 逆算すると468,200円×0.42%≈1,966円になるが、直接記載の1,000円を優先する。
    expect(parseListPage(html)[0].value).toBe(1000);
  });

  test('leaves value undefined when neither a "円相当" pattern nor both fallback fields are present', () => {
    const html = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p><a href="x" class="kigyoumei">利回り欠損企業</a>（8888）</p>
<p>【優待内容】記念品（1点～）</p>
<p>【権利確定月】<span class="tousi_price">6月</span></p>
<p>【必要投資金額】<span class="tousi_price">50,000円</span></p>
</div>
<!-- ▲ランキング_ブロック -->
`;
    expect(parseListPage(html)[0].value).toBeUndefined();
  });

  test('skips a block missing a required field entirely rather than throwing', () => {
    const html = `
<!-- ▼ランキング_ブロック -->
<div class="table_tr">
<p>企業名も権利確定月も無い壊れたブロック</p>
</div>
<!-- ▲ランキング_ブロック -->
`;
    expect(parseListPage(html)).toEqual([]);
  });
});

describe('fetchMonthListings', () => {
  test('fetches page 1, follows pagination to the last linked page number, and merges results', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_PAGE_HTML }) // august.html (has pagination up to page 3)
      .mockResolvedValueOnce({ ok: true, text: async () => '<!-- ▼ランキング_ブロック --><div class="table_tr"><p><a href="x" class="kigyoumei">ページ2企業</a>（4444）</p><p>【優待内容】商品券（1,000円相当～）</p><p>【権利確定月】<span class="tousi_price">8月</span></p></div><!-- ▲ランキング_ブロック -->' }) // august2.html
      .mockResolvedValueOnce({ ok: true, text: async () => '<!-- ▼ランキング_ブロック --><div class="table_tr"><p><a href="x" class="kigyoumei">ページ3企業</a>（5555）</p><p>【優待内容】商品券（2,000円相当～）</p><p>【権利確定月】<span class="tousi_price">8月</span></p></div><!-- ▲ランキング_ブロック -->' }); // august3.html

    const entries = await fetchMonthListings('august');

    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(mockFetch.mock.calls[0][0]).toBe('https://www.kabuyutai.com/yutai/august.html');
    expect(mockFetch.mock.calls[1][0]).toBe('https://www.kabuyutai.com/yutai/august2.html');
    expect(mockFetch.mock.calls[2][0]).toBe('https://www.kabuyutai.com/yutai/august3.html');
    expect(entries.map((e) => e.ticker)).toEqual(['2157', '2164', '4444', '5555']);
  });

  test('fetches only page 1 when there is no pagination block', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      text: async () =>
        '<!-- ▼ランキング_ブロック --><div class="table_tr"><p><a href="x" class="kigyoumei">単独企業</a>（6666）</p><p>【優待内容】QUOカード（500円相当～）</p><p>【権利確定月】<span class="tousi_price">12月</span></p></div><!-- ▲ランキング_ブロック -->',
    });

    const entries = await fetchMonthListings('december');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(entries.map((e) => e.ticker)).toEqual(['6666']);
  });

  test('throws when a page request fails', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    await expect(fetchMonthListings('august')).rejects.toThrow('kabuyutai.com error 500');
  });
});

describe('fetchAllListings', () => {
  test('fetches all 12 months and concatenates the results', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '' }); // 空ページ(パース結果0件)を12ヶ月分返す

    const entries = await fetchAllListings();

    expect(mockFetch).toHaveBeenCalledTimes(12);
    expect(entries).toEqual([]);
  });

  test('logs and continues past a single month that fails to fetch', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // MONTHS配列の順序(january, february, march, ...)通りに1回ずつ応答を積む。
      // marchだけfetch自体がrejectし、他の11ヶ月は空ページ(0件)を返す。
      mockFetch
        .mockResolvedValueOnce({ ok: true, text: async () => '' }) // january
        .mockResolvedValueOnce({ ok: true, text: async () => '' }) // february
        .mockRejectedValueOnce(new Error('network error')) // march: fails
        .mockResolvedValue({ ok: true, text: async () => '' }); // april〜december

      const entries = await fetchAllListings();

      expect(mockFetch).toHaveBeenCalledTimes(12);
      expect(entries).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('march'), expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('returns the successfully-scraped entries from the other 11 months when one month fails', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const aprilHtml =
        '<!-- ▼ランキング_ブロック --><div class="table_tr"><p><a href="x" class="kigyoumei">4月企業</a>（1234）</p><p>【優待内容】QUOカード（500円相当～）</p><p>【権利確定月】<span class="tousi_price">4月</span></p></div><!-- ▲ランキング_ブロック -->';

      mockFetch
        .mockResolvedValueOnce({ ok: true, text: async () => '' }) // january
        .mockResolvedValueOnce({ ok: true, text: async () => '' }) // february
        .mockRejectedValueOnce(new Error('network error')) // march: fails
        .mockResolvedValueOnce({ ok: true, text: async () => aprilHtml }) // april: succeeds with an entry
        .mockResolvedValue({ ok: true, text: async () => '' }); // may〜december

      const entries = await fetchAllListings();

      // marchが例外を投げても、他の月(ここではapril)の結果は失われずに返る。
      expect(entries.map((e) => e.ticker)).toEqual(['1234']);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe('findTicker', () => {
  test('stops scanning months once the ticker is found', async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: true, text: async () => '' }) // january: not found
      .mockResolvedValueOnce({ ok: true, text: async () => SAMPLE_PAGE_HTML }); // february: found (2157)

    const result = await findTicker('2157');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ ticker: '2157', companyName: 'コシダカホールディングス' });
  });

  test('returns undefined when no month contains the ticker', async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => '' });

    const result = await findTicker('9999');

    expect(mockFetch).toHaveBeenCalledTimes(12);
    expect(result).toBeUndefined();
  });
});
