// OAuthのメタデータ文書。claude.aiはここを読んで認可サーバー(Cognito)を見つける。
export interface CognitoSettings { region: string; userPoolId: string; domainUrl: string }

// RFC 9728: 保護リソース(このMCPサーバー)のメタデータ。認可サーバーはAPI自身を指し、
// そこから下の認可サーバーメタデータ(RFC 8414)へ辿らせる。
export function protectedResourceMetadata(apiBase: string): Record<string, unknown> {
  return {
    resource: `${apiBase}/mcp`,
    authorization_servers: [apiBase],
    scopes_supported: ['openid', 'email'],
    bearer_methods_supported: ['header'],
  };
}

// RFC 8414: 認可サーバーのメタデータ。実体はCognitoへ転送する。
// CognitoはDynamic Client Registrationに対応しないので registration_endpoint は載せない
// (claude.ai側でクライアントIDとシークレットを手入力する)。
export function authorizationServerMetadata(apiBase: string, cognito: CognitoSettings): Record<string, unknown> {
  return {
    issuer: apiBase,
    authorization_endpoint: `${cognito.domainUrl}/oauth2/authorize`,
    token_endpoint: `${cognito.domainUrl}/oauth2/token`,
    revocation_endpoint: `${cognito.domainUrl}/oauth2/revoke`,
    jwks_uri: `https://cognito-idp.${cognito.region}.amazonaws.com/${cognito.userPoolId}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    scopes_supported: ['openid', 'email'],
  };
}
