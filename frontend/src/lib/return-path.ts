// ログイン後の戻り先の検証。ログイン前のページをOIDCのstateに入れてCognitoへ渡し、
// 戻ってきたらそのページへ遷移する。stateはURL経由で往復するので信用せず、
// 「/で始まり//で始まらない相対パス」だけを許可する(外部URLへのオープンリダイレクト防止)。
// ブラウザは \ を / と同じに扱うため /\ も //扱いで拒否し、制御文字を含むものも拒否する。
// 許可しないものはトップ(/)にする。
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export function safeReturnPath(candidate: unknown): string {
  if (typeof candidate !== 'string') return '/';
  if (!candidate.startsWith('/')) return '/';
  if (candidate.startsWith('//') || candidate.startsWith('/\\')) return '/';
  if (CONTROL_CHARS.test(candidate)) return '/';
  return candidate;
}
