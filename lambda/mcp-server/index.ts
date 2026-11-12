import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { authorize, parseAllowedSubs, type TokenVerifier } from './auth';
import { authorizationServerMetadata, protectedResourceMetadata } from './metadata';
import { GYAKUHIBU_TOOL, callGyakuhibuForecast } from './tool';

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const JSON_HEADERS = { 'content-type': 'application/json' };

let verifier: TokenVerifier | null = null;
export function setTokenVerifierForTest(v: TokenVerifier | null): void { verifier = v; }
function getVerifier(): TokenVerifier {
  if (!verifier) {
    const v = CognitoJwtVerifier.create({ userPoolId: process.env.USER_POOL_ID!, tokenUse: 'access', clientId: process.env.MCP_CLIENT_ID! });
    verifier = { verify: async (t) => ({ sub: (await v.verify(t)).sub }) };
  }
  return verifier;
}

const json = (statusCode: number, body: unknown, headers: Record<string, string> = {}): APIGatewayProxyResultV2 =>
  ({ statusCode, headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
const rpcError = (statusCode: number, id: unknown, code: number, message: string): APIGatewayProxyResultV2 =>
  json(statusCode, { jsonrpc: '2.0', id, error: { code, message } });

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const apiBase = `https://${event.requestContext.domainName}`;
  switch (event.routeKey) {
    case 'GET /.well-known/oauth-protected-resource':
    case 'GET /.well-known/oauth-protected-resource/mcp':
      return json(200, protectedResourceMetadata(apiBase));
    case 'GET /.well-known/oauth-authorization-server':
    case 'GET /.well-known/openid-configuration':
      return json(200, authorizationServerMetadata(apiBase, {
        region: process.env.AWS_REGION!, userPoolId: process.env.USER_POOL_ID!, domainUrl: process.env.COGNITO_DOMAIN_URL!,
      }));
    case 'GET /mcp':
      return { statusCode: 405, headers: { Allow: 'POST' } };
    case 'POST /mcp':
      break;
    default:
      return json(404, { error: 'Not Found' });
  }

  const auth = await authorize(event.headers?.authorization, apiBase, getVerifier(), parseAllowedSubs(process.env.MCP_ALLOWED_SUBS));
  if (!auth.ok) {
    // HTTP APIのヘッダー名は小文字で扱う
    const headers = Object.fromEntries(Object.entries(auth.headers).map(([k, v]) => [k.toLowerCase(), v]));
    return json(auth.statusCode, { error: auth.message }, headers);
  }

  let message: unknown;
  try {
    const text = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    message = JSON.parse(text);
  } catch {
    return rpcError(400, null, -32700, 'Parse error');
  }
  // MCP 2025-06-18でバッチは廃止
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return rpcError(400, null, -32600, 'Invalid Request');
  }
  const req = message as { id?: string | number | null; method?: unknown; params?: Record<string, unknown> };
  const method = typeof req.method === 'string' ? req.method : '';
  const params = req.params ?? {};
  const toolName = method === 'tools/call' && typeof params.name === 'string' ? params.name : undefined;
  console.log(JSON.stringify({ event: 'mcp-access', sub: auth.sub, method, ...(method === 'tools/call' ? { tool: toolName } : {}) }));

  // idが無いものは通知
  if (req.id === undefined) return { statusCode: 202 };
  const id = req.id;
  const ok = (result: unknown) => json(200, { jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      const protocolVersion = typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-06-18';
      return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'j-quants-gyakuhibu', version: '1.0.0' } });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: [GYAKUHIBU_TOOL] });
    case 'tools/call':
      if (toolName !== GYAKUHIBU_TOOL.name) return rpcError(200, id, -32602, `Unknown tool: ${String(params.name)}`);
      try {
        return ok(await callGyakuhibuForecast(params.arguments));
      } catch (e) {
        console.error('mcp tool failed', e);
        return rpcError(200, id, -32603, 'Internal error');
      }
    default:
      return rpcError(200, id, -32601, `Method not found: ${method}`);
  }
}
