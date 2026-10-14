import type { PreTokenGenerationV2TriggerEvent } from 'aws-lambda';
import { handler } from '../lambda/pre-token-generation/index';

function makeEvent(userAttributes: Record<string, string>): PreTokenGenerationV2TriggerEvent {
  return {
    version: '2',
    triggerSource: 'TokenGeneration_HostedAuth',
    region: 'ap-northeast-1',
    userPoolId: 'ap-northeast-1_test',
    userName: 'test-sub-0001',
    callerContext: { awsSdkVersion: 'aws-sdk-unknown-unknown', clientId: 'test-client' },
    request: { userAttributes, groupConfiguration: { groupsToOverride: [], iamRolesToOverride: [] } },
    response: { claimsAndScopeOverrideDetails: {} },
  } as PreTokenGenerationV2TriggerEvent;
}

const invoke = (event: PreTokenGenerationV2TriggerEvent) =>
  (handler as (e: PreTokenGenerationV2TriggerEvent) => Promise<PreTokenGenerationV2TriggerEvent>)(event);

test('adds the email attribute to the access token (Cognito puts it only in the ID token by default)', async () => {
  const result = await invoke(makeEvent({ sub: 'test-sub-0001', email: 'tester@example.com', email_verified: 'true' }));

  expect(result.response.claimsAndScopeOverrideDetails.accessTokenGeneration?.claimsToAddOrOverride).toEqual({
    email: 'tester@example.com',
  });
});

test('leaves the tokens untouched when the user has no email attribute', async () => {
  const result = await invoke(makeEvent({ sub: 'test-sub-0001' }));

  expect(result.response.claimsAndScopeOverrideDetails.accessTokenGeneration).toBeUndefined();
});

test('does not touch the ID token or group settings', async () => {
  const result = await invoke(makeEvent({ sub: 'test-sub-0001', email: 'tester@example.com' }));

  expect(result.response.claimsAndScopeOverrideDetails.idTokenGeneration).toBeUndefined();
  expect(result.response.claimsAndScopeOverrideDetails.groupOverrideDetails).toBeUndefined();
});
