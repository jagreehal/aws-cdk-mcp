import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { story } from 'executable-stories-vitest';
import { afterEach, expect, test, vi } from 'vitest';
import { handler } from '../src/runtime/protected-resource';

const event: APIGatewayProxyEventV2 = {
  version: '2.0',
  routeKey: 'GET /.well-known/oauth-protected-resource/docs/mcp',
  rawPath: '/.well-known/oauth-protected-resource/docs/mcp',
  rawQueryString: '',
  headers: {},
  requestContext: {
    accountId: '123456789012',
    apiId: 'root',
    domainName: 'docs.example.com',
    domainPrefix: 'docs',
    http: {
      method: 'GET',
      path: '/.well-known/oauth-protected-resource/docs/mcp',
      protocol: 'HTTP/1.1',
      sourceIp: '127.0.0.1',
      userAgent: 'test',
    },
    requestId: 'test',
    routeKey: 'GET /.well-known/oauth-protected-resource/docs/mcp',
    stage: '$default',
    time: '',
    timeEpoch: 0,
  },
  isBase64Encoded: false,
};

afterEach(() => vi.unstubAllEnvs());

story.feature({
  title: 'Protected-resource metadata',
  narrative: 'OAuth clients discover the full public resource URL, including API mapping prefixes.',
  tags: ['oauth', 'runtime'],
});

test('advertises the configured public URL even when the request uses the execute-api host', async ({
  task,
}) => {
  story.init(task);

  story.given('an endpoint mapped at /docs/mcp');
  vi.stubEnv('PUBLIC_RESOURCE_URL', 'https://docs.example.com/docs/mcp');
  vi.stubEnv('MCP_PATH', '/mcp');
  vi.stubEnv('AUTHORIZATION_SERVER', 'https://auth.example.com');
  vi.stubEnv('SCOPES', 'mcp read');

  story.when('the metadata Lambda receives a request through the gateway host');

  const response = await handler({
    ...event,
    requestContext: {
      ...event.requestContext,
      domainName: 'abc.execute-api.eu-west-1.amazonaws.com',
    },
  });

  story.then('clients receive the public resource and the configured authorization server');
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body ?? '')).toEqual({
    resource: 'https://docs.example.com/docs/mcp',
    authorization_servers: ['https://auth.example.com'],
    scopes_supported: ['mcp', 'read'],
    bearer_methods_supported: ['header'],
  });
});

test('keeps request-domain discovery for deployments without publicUrl', async ({ task }) => {
  story.init(task);

  story.given('the existing configuration with no explicit public URL');
  vi.stubEnv('PUBLIC_RESOURCE_URL', undefined);
  vi.stubEnv('MCP_PATH', '/mcp');
  vi.stubEnv('AUTHORIZATION_SERVER', 'https://auth.example.com');

  story.then('the resource still follows the request domain and MCP route');
  const response = await handler(event);

  expect(JSON.parse(response.body ?? '').resource).toBe('https://docs.example.com/mcp');
});
