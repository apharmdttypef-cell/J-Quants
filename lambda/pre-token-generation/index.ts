// Cognito User PoolのPre Token Generationトリガー(V2、Essentialsプラン以上で利用可)。
// APIはアクセストークンで認可するが、Cognitoのアクセストークンには既定でemailが入らない
// (IDトークンにだけ入る)。reference-apiのgetCallerがメールアドレスも取れるよう、
// アクセストークンにemailクレームを足す。ユーザー識別そのものは変わらないsubで行う。
import type { PreTokenGenerationV2TriggerEvent, PreTokenGenerationV2TriggerHandler } from 'aws-lambda';

export const handler: PreTokenGenerationV2TriggerHandler = async (event: PreTokenGenerationV2TriggerEvent) => {
  const email = event.request.userAttributes.email;
  if (typeof email === 'string' && email !== '') {
    event.response.claimsAndScopeOverrideDetails = {
      ...event.response.claimsAndScopeOverrideDetails,
      accessTokenGeneration: { claimsToAddOrOverride: { email } },
    };
  }
  return event;
};
