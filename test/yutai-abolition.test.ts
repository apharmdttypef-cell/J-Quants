import { isAbolitionNotice, latestAbolitionNotice } from '../lambda/shared/yutai-abolition';

test('treats a whole-program abolition or termination as an abolition notice', () => {
  expect(isAbolitionNotice('株主優待制度の廃止に関するお知らせ')).toBe(true);
  expect(isAbolitionNotice('2027年３月期配当予想の修正（無配）及び株主優待制度の廃止に関するお知らせ')).toBe(true);
  expect(isAbolitionNotice('現行株主優待制度の終了および持株会社における新株主優待制度の導入方針について')).toBe(true);
});

test('does not treat a partial change that drops one item as an abolition notice', () => {
  // 6577: 制度自体は続く(デジタルギフトだけをやめる)
  expect(isAbolitionNotice('株主優待制度の一部変更（デジタルギフトの廃止）のお知らせ')).toBe(false);
});

test('requires the yutai keyword', () => {
  expect(isAbolitionNotice('定款の一部廃止に関するお知らせ')).toBe(false);
  expect(isAbolitionNotice('事業の終了に関するお知らせ')).toBe(false);
});

test('does not treat an ordinary change as an abolition notice', () => {
  expect(isAbolitionNotice('株主優待制度の変更（拡充）に関するお知らせ')).toBe(false);
});

test('latestAbolitionNotice picks the newest abolition disclosure and ignores others', () => {
  expect(
    latestAbolitionNotice([
      { disclosedAt: '2026-09-10', title: '株主優待制度の廃止に関するお知らせ' },
      { disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関する補足説明' },
      { disclosedAt: '2026-10-20', title: '株主優待制度の変更に関するお知らせ' },
    ]),
  ).toEqual({ disclosedAt: '2026-10-13', title: '株主優待制度の廃止に関する補足説明' });
});

test('latestAbolitionNotice returns null when none qualifies', () => {
  expect(latestAbolitionNotice([{ disclosedAt: '2026-10-20', title: '株主優待制度の変更に関するお知らせ' }])).toBeNull();
  expect(latestAbolitionNotice([])).toBeNull();
});
