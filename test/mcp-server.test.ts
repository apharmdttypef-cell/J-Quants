jest.mock('../lambda/shared/yutai-forecast-detail', () => ({ loadYutaiForecastDetail: jest.fn() }));

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

describe('MCP handler', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
  let handler: any;
  let load: jest.Mock;
  const HOST = 'abc.execute-api.ap-northeast-1.amazonaws.com';

  beforeAll(() => {
    process.env.MCP_ALLOWED_SUBS = 'me';
    process.env.USER_POOL_ID = 'ap-northeast-1_X';
    process.env.MCP_CLIENT_ID = 'client';
    process.env.COGNITO_DOMAIN_URL = 'https://d.auth.ap-northeast-1.amazoncognito.com';
    process.env.AWS_REGION = 'ap-northeast-1';
    const mod = require('../lambda/mcp-server/index');
    mod.setTokenVerifierForTest({
      verify: async (t: string) => { if (t === 'good') return { sub: 'me' }; if (t === 'other') return { sub: 'x' }; throw new Error('bad'); },
    });
    handler = mod.handler;
    load = require('../lambda/shared/yutai-forecast-detail').loadYutaiForecastDetail;
  });
  beforeEach(() => load.mockReset());

  const ev = (routeKey: string, body?: unknown, authorization: string | undefined = 'Bearer good') => ({
    routeKey, rawPath: routeKey.split(' ')[1],
    headers: authorization ? { authorization } : {},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    isBase64Encoded: false,
    requestContext: { domainName: HOST },
  });
  const rpc = (method: string, params?: unknown, id: number | null = 1) =>
    ev('POST /mcp', { jsonrpc: '2.0', ...(id === null ? {} : { id }), method, params });
  const call = async (args: unknown) => {
    const r = await handler(rpc('tools/call', { name: 'get_gyakuhibu_forecast', arguments: args }));
    return JSON.parse(r.body).result;
  };
  const detailFixture = (forecast: unknown = { forecastStatus: 'safe' }) => ({
    detail: {
      ticker: '1234', companyName: 'テスト', content: 'c', value: 1000, unitShares: 100, requiredShares: 100,
      rightsDate: '2026-12-29', maxGyakuhibu: 500, closePrice: 1000, forecast, tseForecast: null,
      history: Array.from({ length: 12 }, (_, i) => ({ rightsDate: `h${i}`, occurred: false })),
      poolBins: [{ a: 1 }], marginTrend: { latest: { date: '2026-11-10' }, series: [1] },
    },
    abolitionNotice: { disclosedDate: '2026-11-01', title: '廃止' },
  });

  test('initialize echoes a supported version, else falls back; no session id', async () => {
    const r = await handler(rpc('initialize', { protocolVersion: '2025-06-18' }));
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    expect(Object.keys(r.headers).map((k) => k.toLowerCase())).not.toContain('mcp-session-id');
    const res = JSON.parse(r.body).result;
    expect(res.protocolVersion).toBe('2025-06-18');
    expect(res.capabilities).toEqual({ tools: {} });
    expect(res.serverInfo.name).toBe('j-quants-gyakuhibu');
    const unknown = JSON.parse((await handler(rpc('initialize', { protocolVersion: '1999-01-01' }))).body).result;
    expect(unknown.protocolVersion).toBe('2025-06-18');
    const older = JSON.parse((await handler(rpc('initialize', { protocolVersion: '2024-11-05' }))).body).result;
    expect(older.protocolVersion).toBe('2024-11-05');
  });

  test('notifications/initialized returns 202 with an empty body', async () => {
    const r = await handler(rpc('notifications/initialized', undefined, null));
    expect(r.statusCode).toBe(202);
    expect(r.body ?? '').toBe('');
  });

  test('ping returns an empty result', async () => {
    expect(JSON.parse((await handler(rpc('ping'))).body).result).toEqual({});
  });

  test('tools/list exposes the single tool', async () => {
    const { tools } = JSON.parse((await handler(rpc('tools/list'))).body).result;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('get_gyakuhibu_forecast');
    expect(tools[0].inputSchema.required).toEqual(['ticker']);
  });

  test('unknown method is -32601', async () => {
    expect(JSON.parse((await handler(rpc('resources/list'))).body).error.code).toBe(-32601);
  });

  test('invalid JSON is -32700 and a batch is -32600', async () => {
    const bad = await handler(ev('POST /mcp', '{nope'));
    expect(bad.statusCode).toBe(400);
    expect(JSON.parse(bad.body)).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    const batch = await handler(ev('POST /mcp', [{ jsonrpc: '2.0', id: 1, method: 'ping' }]));
    expect(JSON.parse(batch.body).error.code).toBe(-32600);
  });

  test('GET /mcp is 405 with Allow: POST', async () => {
    const r = await handler(ev('GET /mcp'));
    expect(r.statusCode).toBe(405);
    expect(r.headers.Allow).toBe('POST');
  });

  test('missing token is 401 with resource_metadata; other sub is 403', async () => {
    const r = await handler(ev('POST /mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, ''));
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toBe(`Bearer resource_metadata="https://${HOST}/.well-known/oauth-protected-resource"`);
    const o = await handler(ev('POST /mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, 'Bearer other'));
    expect(o.statusCode).toBe(403);
  });

  test('metadata endpoints are public', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const r = await handler(ev(`GET ${path}`, undefined, ''));
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body).resource).toBe(`https://${HOST}/mcp`);
    }
    for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
      const r = await handler(ev(`GET ${path}`, undefined, ''));
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body).issuer).toBe(`https://${HOST}`);
    }
  });

  test('tools/call returns a trimmed forecast', async () => {
    load.mockResolvedValue(detailFixture());
    const result = await call({ ticker: ' 1234 ' });
    expect(load).toHaveBeenCalledWith('1234');
    expect(result.isError).toBeUndefined();
    const out = JSON.parse(result.content[0].text);
    expect(out.history).toHaveLength(10);
    expect(out.history[0]).toEqual({ rightsDate: 'h0', occurred: false });
    expect(out).not.toHaveProperty('poolBins');
    expect(out.abolitionNotice).toEqual({ disclosedDate: '2026-11-01', title: '廃止' });
    expect(out.marginTrend).toEqual({ latest: { date: '2026-11-10' } });
  });

  test('unknown ticker is a tool error', async () => {
    load.mockResolvedValue(null);
    const result = await call({ ticker: '9999' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('優待マスタに無い銘柄です');
  });

  test('invalid ticker is a tool error', async () => {
    for (const a of [{ ticker: '12' }, { ticker: 1234 }, {}]) {
      expect((await call(a)).isError).toBe(true);
    }
    expect(load).not.toHaveBeenCalled();
  });

  test('general-only is a normal result', async () => {
    load.mockResolvedValue(detailFixture({ forecastStatus: 'general-only' }));
    const result = await call({ ticker: '1234' });
    expect(result.isError).toBeUndefined();
  });

  test('unknown tool is -32602', async () => {
    const r = await handler(rpc('tools/call', { name: 'nope', arguments: {} }));
    expect(JSON.parse(r.body).error.code).toBe(-32602);
  });

  test('an authorized request logs sub, method and tool only', async () => {
    load.mockResolvedValue(detailFixture());
    const spy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    await call({ ticker: '1234' });
    expect(spy).toHaveBeenCalledWith(JSON.stringify({ event: 'mcp-access', sub: 'me', method: 'tools/call', tool: 'get_gyakuhibu_forecast' }));
    spy.mockRestore();
  });
});
