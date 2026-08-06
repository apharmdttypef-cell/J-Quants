import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';

const mockSecretsSend = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSecretsSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => input),
}));

process.env.SECRET_ARN = 'arn:aws:secretsmanager:ap-northeast-1:123456789012:secret:JQuantsAppPassword';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambda/authorizer/index') as {
  handler: (event: APIGatewayRequestAuthorizerEventV2) => Promise<{ isAuthorized: boolean }>;
};

function makeEvent(headerValue?: string): APIGatewayRequestAuthorizerEventV2 {
  return { headers: headerValue !== undefined ? { 'x-app-password': headerValue } : {} } as APIGatewayRequestAuthorizerEventV2;
}

beforeEach(() => {
  mockSecretsSend.mockReset();
});

test('denies when no password header is provided', async () => {
  const result = await handler(makeEvent());

  expect(result).toEqual({ isAuthorized: false });
  expect(mockSecretsSend).not.toHaveBeenCalled();
});

test('denies when the provided password does not match the secret', async () => {
  mockSecretsSend.mockResolvedValueOnce({ SecretString: 'correct-password' });

  const result = await handler(makeEvent('wrong-password'));

  expect(result).toEqual({ isAuthorized: false });
});

test('authorizes when the provided password matches the secret', async () => {
  mockSecretsSend.mockResolvedValueOnce({ SecretString: 'correct-password' });

  const result = await handler(makeEvent('correct-password'));

  expect(result).toEqual({ isAuthorized: true });
});
