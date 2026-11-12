// claude.aiのMCPコネクタ用の認証。API GatewayのJWTオーソライザーは401に
// WWW-Authenticate(resource_metadata)を付けられず、MCPのOAuth検出が始まらないため、Lambda内で検証する。
export interface TokenVerifier { verify(token: string): Promise<{ sub: string }> }
export type AuthResult =
  | { ok: true; sub: string }
  | { ok: false; statusCode: 401 | 403; headers: Record<string, string>; message: string };

// SSMのStringパラメータは空にできないので、未設定の意味で'none'を置く。
export function parseAllowedSubs(raw: string | undefined): Set<string> {
  return new Set((raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '' && s !== 'none'));
}

export async function authorize(authorizationHeader: string | undefined, apiBase: string,
  verifier: TokenVerifier, allowedSubs: Set<string>): Promise<AuthResult> {
  const unauthorized: AuthResult = { ok: false, statusCode: 401, message: 'Unauthorized',
    headers: { 'WWW-Authenticate': `Bearer resource_metadata="${apiBase}/.well-known/oauth-protected-resource"` } };
  const match = /^Bearer\s+(\S+)$/i.exec(authorizationHeader ?? '');
  if (!match) return unauthorized;
  let sub: string;
  try {
    sub = (await verifier.verify(match[1])).sub;
  } catch {
    return unauthorized;
  }
  // 許可リストが空なら誰も通さない(フェイルクローズ)。データ規約上、本人だけに限る。
  if (!allowedSubs.has(sub)) return { ok: false, statusCode: 403, headers: {}, message: 'Forbidden' };
  return { ok: true, sub };
}
