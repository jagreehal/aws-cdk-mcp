import { createHash, randomBytes } from 'node:crypto';
import type { APIGatewayRequestAuthorizerEventV2 } from 'aws-lambda';
import { story } from 'executable-stories-vitest';
import { afterEach, expect, test, vi } from 'vitest';
import { ApiKeysSchema, authorize, handler } from '../src/runtime/api-key-authorizer';

const key = randomBytes(32).toString('hex');

const sha256 = createHash('sha256').update(key).digest('hex');

const keys = [{ sha256, clientId: 'team-bot', scopes: ['echo'] }];

const now = 1_800_000_000;

const event = (credential?: string): APIGatewayRequestAuthorizerEventV2 => ({
  version: '2.0',
  cookies: [],
  type: 'REQUEST',
  routeArn: 'arn:aws:execute-api:eu-west-1:123456789012:abc/$default/POST/mcp',
  identitySource: credential ? [credential] : [],
  routeKey: 'POST /mcp',
  rawPath: '/mcp',
  rawQueryString: '',
  headers: credential ? { 'x-api-key': credential } : {},
  requestContext: {
    accountId: '123456789012',
    apiId: 'abc',
    domainName: 'example.com',
    domainPrefix: 'abc',
    http: {
      method: 'POST',
      path: '/mcp',
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'test',
    },
    requestId: 'test',
    routeKey: 'POST /mcp',
    stage: '$default',
    time: '',
    timeEpoch: 0,
  },
});

afterEach(() => vi.unstubAllEnvs());

story.feature({
  title: 'API key authorizer',
  narrative: `
    Clients call the MCP endpoint with an \`x-api-key\` header. The Lambda authorizer
    hashes the key, looks it up in \`API_KEYS\`, and returns a short-lived scoped
    identity. Anything unexpected fails closed.
  `,
  tags: ['auth', 'api-key'],
});

test('valid keys become scoped clients without exposing the key or its hash', ({ task }) => {
  story.init(task);

  story.given('a key registered for client "team-bot" with scope "echo"');
  story.when('the key is authorized');
  const identity = authorize(key, keys, now);

  story.then('the identity carries the client, scopes and a 60 second expiry');
  story.json({ label: 'Identity', value: identity });
  expect(identity).toEqual({ sub: 'team-bot', scopes: 'echo', exp: now + 60 });

  story.but('neither the key nor its hash leak into the identity');
  expect(JSON.stringify(identity)).not.toContain(key);
  expect(JSON.stringify(identity)).not.toContain(sha256);
});

test('missing, unknown, short, whitespace and multiple keys fail closed', ({ task }) => {
  story.init(task);

  story.given('a key registered for "team-bot"');
  story.when('malformed or unknown credentials are presented');
  story.table({
    label: 'Rejected credentials',
    columns: ['Case'],
    rows: [
      ['missing'],
      ['empty'],
      ['too short'],
      ['unknown 64 chars'],
      ['leading space'],
      ['two keys'],
    ],
  });
  story.then('none of them are authorized');

  for (const candidate of [undefined, '', 'short', 'x'.repeat(64), ` ${key}`, `${key},${key}`]) {
    expect(authorize(candidate, keys, now)).toBeUndefined();
  }
});

test('each key grants only its own client and scopes', ({ task }) => {
  story.init(task);

  story.given('two keys: "team-bot" with "echo" and "reader" with "read"');
  const other = randomBytes(32).toString('hex');

  const entries = [
    ...keys,
    {
      sha256: createHash('sha256').update(other).digest('hex'),
      clientId: 'reader',
      scopes: ['read'],
    },
  ];

  story.when('the reader key is authorized');
  story.then('the identity is "reader" with only "read"');
  expect(authorize(other, entries, now)).toEqual({ sub: 'reader', scopes: 'read', exp: now + 60 });
});

test('expired keys are refused and identity lifetime does not exceed key expiry', ({ task }) => {
  story.init(task);

  story.given('a key that has already expired');
  story.then('it is refused');
  expect(authorize(key, [{ ...keys[0], expiresAt: now }], now)).toBeUndefined();

  story.given('a key expiring in 10 seconds');
  story.then('the identity expires with the key, not after 60 seconds');
  expect(authorize(key, [{ ...keys[0], expiresAt: now + 10 }], now)?.exp).toBe(now + 10);
});

test('configuration rejects empty keys, invalid hashes, duplicate hashes and ambiguous scopes', ({
  task,
}) => {
  story.init(task);

  story.when('API_KEYS is empty, has a bad hash, a duplicate hash, or a scope with a space');
  story.then('the schema rejects it');

  for (const entries of [
    [],
    [{ ...keys[0], sha256: key.slice(0, 10) }],
    [keys[0], keys[0]],
    [{ ...keys[0], scopes: ['read echo'] }],
  ]) {
    expect(ApiKeysSchema.safeParse(entries).success).toBe(false);
  }

  story.and('uppercase hashes are normalised to lowercase');
  expect(ApiKeysSchema.parse([{ ...keys[0], sha256: sha256.toUpperCase() }])[0].sha256).toBe(
    sha256,
  );
});

test('Lambda reads x-api-key, refuses missing keys, and honors removal on the next request', async ({
  task,
}) => {
  story.init(task);

  story.given('API_KEYS contains the "team-bot" key');
  vi.stubEnv('API_KEYS', JSON.stringify(keys));

  story.when('a request sends the key in x-api-key');
  story.then('it is authorized as "team-bot"');
  expect((await handler(event(key))).context?.sub).toBe('team-bot');

  story.when('a request sends no key');
  story.then('it is refused');
  expect((await handler(event())).isAuthorized).toBe(false);

  story.when('the key is removed from API_KEYS');
  story.then('the next request with it is refused');
  vi.stubEnv('API_KEYS', JSON.stringify([{ ...keys[0], sha256: 'a'.repeat(64) }]));
  expect((await handler(event(key))).isAuthorized).toBe(false);
});

test('Lambda fails closed on malformed configuration', async ({ task }) => {
  story.init(task);

  story.given('API_KEYS is not valid JSON');
  vi.stubEnv('API_KEYS', '{');

  story.when('a request sends a key');
  story.then('it is refused');
  expect(await handler(event(key))).toEqual({ isAuthorized: false, context: undefined });
});
