import { authorize, parseAllowedSubs } from '../lambda/mcp-server/auth';
import { authorizationServerMetadata, protectedResourceMetadata } from '../lambda/mcp-server/metadata';

const API = 'https://abc.execute-api.ap-northeast-1.amazonaws.com';
const okVerifier = { verify: jest.fn(async () => ({ sub: 'me' })) };
const badVerifier = { verify: jest.fn(async () => { throw new Error('JwtExpiredError'); }) };

describe('authorize', () => {
  test('401 with resource_metadata when the header is missing', async () => {
    const r = await authorize(undefined, API, okVerifier, new Set(['me']));
    expect(r).toEqual({ ok: false, statusCode: 401, message: expect.any(String),
      headers: { 'WWW-Authenticate': `Bearer resource_metadata="${API}/.well-known/oauth-protected-resource"` } });
  });
  test('401 when the header is not a Bearer token', async () => {
    expect((await authorize('Basic xyz', API, okVerifier, new Set(['me']))).ok).toBe(false);
  });
  test('401 when the verifier rejects the token (bad signature, expired, other client)', async () => {
    const r = await authorize('Bearer t', API, badVerifier, new Set(['me']));
    expect(r.ok === false && r.statusCode).toBe(401);
  });
  test('403 when the sub is not allowed', async () => {
    const r = await authorize('Bearer t', API, okVerifier, new Set(['someone-else']));
    expect(r.ok === false && r.statusCode).toBe(403);
  });
  test('403 for everyone when the allow list is empty', async () => {
    const r = await authorize('Bearer t', API, okVerifier, parseAllowedSubs(''));
    expect(r.ok === false && r.statusCode).toBe(403);
  });
  test('ok with the sub when allowed', async () => {
    await expect(authorize('Bearer t', API, okVerifier, new Set(['me']))).resolves.toEqual({ ok: true, sub: 'me' });
  });
});

test('parseAllowedSubs trims, drops blanks and the placeholder "none"', () => {
  expect([...parseAllowedSubs(' a , ,b ')]).toEqual(['a', 'b']);
  expect(parseAllowedSubs(undefined).size).toBe(0);
  expect(parseAllowedSubs('none').size).toBe(0);
});

test('protected resource metadata points at the API as the authorization server', () => {
  expect(protectedResourceMetadata(API)).toEqual({
    resource: `${API}/mcp`,
    authorization_servers: [API],
    scopes_supported: ['openid', 'email'],
    bearer_methods_supported: ['header'],
  });
});

test('authorization server metadata forwards to Cognito and requires S256', () => {
  const m = authorizationServerMetadata(API, {
    region: 'ap-northeast-1', userPoolId: 'ap-northeast-1_X', domainUrl: 'https://d.auth.ap-northeast-1.amazoncognito.com',
  });
  expect(m).toEqual({
    issuer: API,
    authorization_endpoint: 'https://d.auth.ap-northeast-1.amazoncognito.com/oauth2/authorize',
    token_endpoint: 'https://d.auth.ap-northeast-1.amazoncognito.com/oauth2/token',
    revocation_endpoint: 'https://d.auth.ap-northeast-1.amazoncognito.com/oauth2/revoke',
    jwks_uri: 'https://cognito-idp.ap-northeast-1.amazonaws.com/ap-northeast-1_X/.well-known/jwks.json',
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: ['openid', 'email'],
  });
});
