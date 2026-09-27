// The example Lambda answering real 2026-07-28 requests, as API Gateway would deliver them.
import { story } from 'executable-stories-vitest';
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { handler as tracedHandler } from '../example/mcp-autotel';
import { init } from 'autotel';
import { InMemorySpanExporter } from 'autotel/exporters';
import { SimpleSpanProcessor } from 'autotel/processors';
import type { ApiGatewayRequestContextV2 } from 'hono/aws-lambda';
import { z } from 'zod';
import {
  bearerChallenge,
  handler,
  originAllowed,
  parseAllowedOrigins,
  roleArnOf,
  signedHeaders,
  type GatewayAuthorizer,
  type HttpApiEvent,
} from '../example/mcp';

/** The event the handler takes: API Gateway HTTP API, payload v2. */

const now = () => Math.floor(Date.now() / 1000);

const envelope = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

/** The params these tests send; `_meta` is the envelope every 2026-07-28 request carries. */
type RequestParams = {
  name?: string;
  arguments?: Record<string, string>;
  notifications?: Record<string, boolean>;
};

/** `meta` adds to the envelope, e.g. the W3C `traceparent` a traced client sends. */
const request = (
  method: string,
  params: RequestParams = {},
  meta: Record<string, string> = {},
) => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  params: { ...params, _meta: { ...envelope, ...meta } },
});

const call = (name: string, args: Record<string, string> = {}) =>
  request('tools/call', { name, arguments: args });

const lambdaAuth = (email: string, scopes: string, exp = now() + 600): GatewayAuthorizer => ({
  lambda: { email, sub: '1', scopes, exp },
});

const BOT_ROLE = 'arn:aws:iam::123456789012:role/SlackBot';

/** API Gateway's SigV4 verdict for a Lambda whose role is `role`. */
const iamAuth = (role: string): GatewayAuthorizer => ({
  iam: {
    accessKey: 'ASIAEXAMPLE',
    accountId: '123456789012',
    callerId: 'AROAEXAMPLE:bot-session',
    cognitoIdentity: null,
    principalOrgId: null,
    userArn: `arn:aws:sts::123456789012:assumed-role/${role}/bot-session`,
    userId: 'AROAEXAMPLE:bot-session',
  },
});

const jwtAuth = (scopes: string[], exp = now() + 600): GatewayAuthorizer => ({
  jwt: { claims: { sub: 'user-1', email: 'jwt@example.com', exp: String(exp) }, scopes },
});

function event(
  body: ReturnType<typeof request>,
  opts: { authorizer?: GatewayAuthorizer; headers?: HeadersInit } = {},
): HttpApiEvent {
  // `Headers` lower-cases names, as API Gateway v2 does.
  const headers = new Headers(opts.headers);

  headers.set('content-type', 'application/json');
  headers.set('accept', 'application/json, text/event-stream');
  headers.set('host', 'abc.execute-api.eu-west-1.amazonaws.com');
  headers.set('mcp-protocol-version', '2026-07-28');
  // Must match the body: the SDK answers -32020 when they disagree.
  headers.set('mcp-method', body.method);

  if (body.params.name) headers.set('mcp-name', body.params.name);

  // What API Gateway puts on a v2 event. `authorizer` carries `lambda`, which hono doesn't model.
  const requestContext: ApiGatewayRequestContextV2 = {
    accountId: '123456789012',
    apiId: 'abc',
    authentication: null,
    authorizer: opts.authorizer ?? {},
    domainName: 'abc.execute-api.eu-west-1.amazonaws.com',
    domainPrefix: 'abc',
    http: {
      method: 'POST',
      path: '/mcp',
      protocol: 'HTTP/1.1',
      sourceIp: '1.2.3.4',
      userAgent: 'test',
    },
    requestId: 'req-1',
    routeKey: 'POST /mcp',
    stage: '$default',
    time: '27/Sep/2026:08:00:00 +0000',
    timeEpoch: 1_790_000_000_000,
  };

  return {
    version: '2.0',
    routeKey: 'POST /mcp',
    rawPath: '/mcp',
    rawQueryString: '',
    headers: Object.fromEntries(headers),
    requestContext,
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

/** Only the parts of a JSON-RPC response the tests assert on; parsing, not asserting, the shape. */
const BodySchema = z.object({
  result: z
    .object({
      content: z.array(z.object({ text: z.string() })).optional(),
      isError: z.boolean().optional(),
      capabilities: z
        .object({ tools: z.object({ listChanged: z.boolean().optional() }).optional() })
        .optional(),
    })
    .optional(),
  // JSON-RPC error object from the SDK, or an OAuth error code from the handler's own 401.
  error: z.union([z.object({ code: z.number(), message: z.string() }), z.string()]).optional(),
});

type Body = z.infer<typeof BodySchema>;

/** The Lambda context wrapHandler reads: function name for cold starts, request id for the span. */
const lambdaContext: Parameters<typeof tracedHandler>[1] = {
  callbackWaitsForEmptyEventLoop: false,
  functionName: 'aws-cdk-mcp-example',
  functionVersion: '$LATEST',
  invokedFunctionArn: 'arn:aws:lambda:eu-west-2:123456789012:function:aws-cdk-mcp-example',
  memoryLimitInMB: '512',
  awsRequestId: 'req-1',
  logGroupName: '/aws/lambda/aws-cdk-mcp-example',
  logStreamName: 'stream',
  getRemainingTimeInMillis: () => 29_000,
  done: () => undefined,
  fail: () => undefined,
  succeed: () => undefined,
};

async function invoke(e: HttpApiEvent, run: typeof tracedHandler = handler) {
  const res = await run(e, lambdaContext);

  return {
    status: res.statusCode,
    contentType: res.headers?.['content-type'],
    challenge: res.headers?.['www-authenticate'],
    body: BodySchema.parse(JSON.parse(res.body)),
  };
}

const text = (r: { body: Body }) => r.body.result?.content?.[0].text;

story.feature({
  title: 'Example MCP Lambda',
  narrative: `
    The example Lambda answers stateless 2026-07-28 MCP requests exactly as API Gateway
    delivers them. Identity comes from whichever authorizer ran (Lambda, JWT or IAM),
    scopes gate each tool, and anything it cannot trust is refused.
  `,
  tags: ['example', 'handler'],
});

describe('tracing', () => {
  const exporter = new InMemorySpanExporter();

  // Tracing on for the whole block: the body is only rewritten when a span is active.
  beforeAll(() => {
    init({ service: 'test', spanProcessors: [new SimpleSpanProcessor(exporter)] });
  });

  test('one trace, one chain: caller → Lambda invocation → tool', async ({ task }) => {
    story.init(task, { tags: ['tracing'] });

    story.given('a caller whose request carries a W3C traceparent');
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const callerSpanId = '00f067aa0ba902b7';

    story.kv({ label: 'traceparent', value: `00-${traceId}-${callerSpanId}-01` });

    story.when('the traced handler runs the whoami tool');
    await invoke(
      event(
        request(
          'tools/call',
          { name: 'whoami', arguments: {} },
          { traceparent: `00-${traceId}-${callerSpanId}-01` },
        ),
        { authorizer: lambdaAuth('bob@example.com', 'read') },
      ),
      tracedHandler,
    );

    const spans = exporter.getFinishedSpans();
    const invocation = spans.find((s) => s.name === `lambda.${lambdaContext.functionName}`);
    const tool = spans.find((s) => s.name.includes('whoami'));

    story.then("the Lambda invocation joins the caller's trace as its child");
    // The invocation joins the caller's trace, as the caller's child…
    expect(invocation?.spanContext().traceId).toBe(traceId);
    expect(invocation?.parentSpanContext?.spanId).toBe(callerSpanId);

    story.and('the tool span is a child of the invocation, not a sibling');
    // …and the tool call is the invocation's child, not a sibling hanging off the caller.
    expect(tool?.spanContext().traceId).toBe(traceId);
    expect(tool?.parentSpanContext?.spanId).toBe(invocation?.spanContext().spanId);
  });

  test("a traced request past the SDK's byte limit still gets its 413", async ({ task }) => {
    story.init(task, { tags: ['tracing'] });

    story.given('a traced tools/call of about 4.5 MB on the wire');

    // `€` is one UTF-16 unit but three UTF-8 bytes: ~1.5M characters, ~4.5 MB on the wire.
    const oversized = request(
      'tools/call',
      { name: 'echo', arguments: { text: '€'.repeat(1_500_000) } },
      { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
    );

    story.when('the traced handler receives it');

    const r = await invoke(
      event(oversized, { authorizer: lambdaAuth('bob@example.com', 'echo') }),
      tracedHandler,
    );

    story.then('it answers 413');
    expect(r.status).toBe(413);
  });
});

describe('example MCP Lambda', () => {
  test('API key clients use sub as identity and receive only their granted scopes', async ({
    task,
  }) => {
    story.init(task, { tags: ['api-key'] });

    story.given('an API key client "team-bot" granted "echo"');

    const authorizer: GatewayAuthorizer = {
      lambda: { sub: 'team-bot', scopes: 'echo', exp: now() + 60 },
    };

    story.when('it calls whoami');
    const result = await invoke(event(call('whoami'), { authorizer }));

    story.then('it is identified by sub with its scopes');
    expect(text(result)).toBe('team-bot: echo');

    story.and('it can call echo');
    expect(text(await invoke(event(call('echo', { text: 'hi' }), { authorizer })))).toBe('hi');

    story.but('a "reader" client granted only "read" cannot call echo');
    expect(
      (
        await invoke(
          event(call('echo', { text: 'hi' }), {
            authorizer: { lambda: { sub: 'reader', scopes: 'read', exp: now() + 60 } },
          }),
        )
      ).body.result?.isError,
    ).toBe(true);
  });

  test('answers a first-message tools/call with no handshake and no session', async ({ task }) => {
    story.init(task);

    story.given('bob, authorized with "read echo", and no prior initialize');
    story.when('the very first message is a tools/call for whoami');

    const r = await invoke(
      event(call('whoami'), { authorizer: lambdaAuth('bob@example.com', 'read echo') }),
    );

    story.then('it answers 200 with bob and his scopes');
    expect(r.status).toBe(200);
    expect(text(r)).toBe('bob@example.com: read, echo');
  });

  describe('scopes gate each tool, whichever authorizer ran', () => {
    test('Lambda authorizer', async ({ task }) => {
      story.init(task, { tags: ['scopes'] });

      story.given('alice has only "read" and bob has "echo", via the Lambda authorizer');
      story.when('both call echo');

      const denied = await invoke(
        event(call('echo', { text: 'hi' }), {
          authorizer: lambdaAuth('alice@example.com', 'read'),
        }),
      );

      const allowed = await invoke(
        event(call('echo', { text: 'hi' }), { authorizer: lambdaAuth('bob@example.com', 'echo') }),
      );

      story.then('alice gets a tool error');
      expect(denied.body.result?.isError).toBe(true);

      story.and('bob gets his echo');
      expect(text(allowed)).toBe('hi');
    });

    test('JWT authorizer: a read-only token cannot call echo', async ({ task }) => {
      story.init(task, { tags: ['scopes'] });

      story.given('one JWT with "read" and another with "echo"');
      story.when('both call echo');

      const denied = await invoke(
        event(call('echo', { text: 'hi' }), { authorizer: jwtAuth(['read']) }),
      );

      const allowed = await invoke(
        event(call('echo', { text: 'hi' }), { authorizer: jwtAuth(['echo']) }),
      );

      story.then('the read-only token gets a tool error');
      expect(denied.body.result?.isError).toBe(true);

      story.and('the echo token gets its echo');
      expect(text(allowed)).toBe('hi');
    });
  });

  test('no identity is refused, not treated as anonymous', async ({ task }) => {
    story.init(task);

    story.given('a request with no authorizer context');
    story.when('it calls whoami');
    story.then('it is refused with 401');
    expect((await invoke(event(call('whoami')))).status).toBe(401);
  });

  test('an identity whose token expired is refused, even if the gateway cached its approval', async ({
    task,
  }) => {
    story.init(task);

    story.given('a Lambda identity and a JWT identity that both expired a second ago');
    const expiredLambda = lambdaAuth('bob@example.com', 'echo', now() - 1);
    const expiredJwt = jwtAuth(['echo'], now() - 1);

    story.when('each calls whoami');
    story.then('both are refused with 401');
    expect((await invoke(event(call('whoami'), { authorizer: expiredLambda }))).status).toBe(401);
    expect((await invoke(event(call('whoami'), { authorizer: expiredJwt }))).status).toBe(401);
  });

  test('a browser Origin that is not allowlisted gets a 403', async ({ task }) => {
    story.init(task, { tags: ['origin'] });

    story.given('no ALLOWED_ORIGINS configured');
    story.when('a request arrives with Origin https://untrusted.example');

    const r = await invoke(
      event(call('whoami'), {
        authorizer: lambdaAuth('bob@example.com', 'read'),
        headers: { origin: 'https://untrusted.example' },
      }),
    );

    story.then('it is refused with 403');
    expect(r.status).toBe(403);
  });

  test('discovery does not advertise list-changed notifications it cannot deliver', async ({
    task,
  }) => {
    story.init(task);

    story.when('a client calls server/discover');

    const r = await invoke(
      event(request('server/discover'), { authorizer: lambdaAuth('bob@example.com', 'read') }),
    );

    story.then('it answers 200');
    expect(r.status).toBe(200);

    story.but('tools.listChanged is not advertised');
    expect(r.body.result?.capabilities?.tools?.listChanged).not.toBe(true);
  });

  test('subscriptions/listen is refused in-band, never opened as a stream', async ({ task }) => {
    story.init(task);

    story.when('a client calls subscriptions/listen for toolsListChanged');

    const r = await invoke(
      event(request('subscriptions/listen', { notifications: { toolsListChanged: true } }), {
        authorizer: lambdaAuth('bob@example.com', 'read'),
      }),
    );

    story.then('no event stream is opened');
    expect(r.contentType).not.toContain('text/event-stream');

    story.and('the response carries a JSON-RPC error');
    expect(r.body.error).toBeDefined();
  });

  describe('with configuration', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    test('an allowlisted browser Origin gets through', async ({ task }) => {
      story.init(task, { tags: ['origin'] });

      story.given('ALLOWED_ORIGINS is https://trusted.example');
      vi.stubEnv('ALLOWED_ORIGINS', 'https://trusted.example');

      story.when('a request arrives with that Origin');

      const r = await invoke(
        event(call('whoami'), {
          authorizer: lambdaAuth('bob@example.com', 'read'),
          headers: { origin: 'https://trusted.example' },
        }),
      );

      story.then('it answers 200');
      expect(r.status).toBe(200);
    });

    test('a refused identity gets a bearer challenge pointing at the metadata', async ({
      task,
    }) => {
      story.init(task);

      story.given('no RESOURCE_METADATA_URL');
      story.when('an unauthenticated request is refused');
      const bare = await invoke(event(call('whoami')));

      story.given('RESOURCE_METADATA_URL is set');
      vi.stubEnv(
        'RESOURCE_METADATA_URL',
        'https://abc.example/.well-known/oauth-protected-resource/mcp',
      );

      story.when('the same request is refused again');
      const withMetadata = await invoke(event(call('whoami')));

      story.then('the first challenge is a bare invalid_token');
      expect(bare.challenge).toBe('Bearer error="invalid_token"');

      story.and('the second points at the protected-resource metadata');
      story.kv({ label: 'WWW-Authenticate', value: withMetadata.challenge ?? '' });
      expect(withMetadata.challenge).toBe(
        'Bearer error="invalid_token", resource_metadata="https://abc.example/.well-known/oauth-protected-resource/mcp"',
      );
    });
  });
});

describe('service callers (auth: iam)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  /** What the bot sends: a SigV4 Authorization header covering `signed`, as aws4fetch writes it. */
  function asBot(role: string, onBehalfOf?: string, signed = 'host;mcp-on-behalf-of;x-amz-date') {
    const headers = new Headers({
      authorization: `AWS4-HMAC-SHA256 Credential=ASIAEXAMPLE/20260927/eu-west-2/execute-api/aws4_request, SignedHeaders=${signed}, Signature=abc123`,
    });

    if (onBehalfOf !== undefined) headers.set('mcp-on-behalf-of', onBehalfOf);

    return event(call('echo', { text: 'hi' }), { authorizer: iamAuth(role), headers });
  }

  const configure = () => {
    vi.stubEnv('TRUSTED_CALLER_ROLES', BOT_ROLE);
    vi.stubEnv(
      'USERS',
      JSON.stringify({ 'Bob@example.com': ['echo'], 'alice@example.com': ['read'] }),
    );
  };

  test("a trusted role acting for a listed user gets that user, and that user's scopes", async ({
    task,
  }) => {
    story.init(task, { tags: ['iam'] });

    story.given('SlackBot is a trusted caller role, bob has "echo" and alice has "read"');
    configure();

    story.when('SlackBot calls echo on behalf of bob, then of alice');
    const bob = await invoke(asBot('SlackBot', 'bob@example.com'));
    const alice = await invoke(asBot('SlackBot', 'alice@example.com'));

    story.then('bob gets his echo');
    expect(text(bob)).toBe('hi');

    story.but('alice gets a tool error');
    expect(alice.body.result?.isError).toBe(true);
  });

  test('a role not in TRUSTED_CALLER_ROLES is refused, however it got past the gateway', async ({
    task,
  }) => {
    story.init(task, { tags: ['iam'] });

    story.given('only SlackBot is trusted');
    configure();

    story.when('SomeAdminRole calls on behalf of bob');
    const r = await invoke(asBot('SomeAdminRole', 'bob@example.com'));

    story.then('it is refused with 403');
    expect(r.status).toBe(403);

    story.and('no OAuth bearer challenge is sent to a SigV4 caller');
    // It signed with SigV4; pointing it at OAuth would be wrong.
    expect(r.challenge).toBeUndefined();
  });

  test('a delegation header outside the signature is refused: it could have been swapped', async ({
    task,
  }) => {
    story.init(task, { tags: ['iam'] });

    story.given('SlackBot is trusted');
    configure();

    story.when('it sends mcp-on-behalf-of without signing that header');
    const r = await invoke(asBot('SlackBot', 'bob@example.com', 'host;x-amz-date'));

    story.then('it is refused with 403');
    expect(r.status).toBe(403);
  });

  test('a trusted role must say who it acts for, and for someone in USERS', async ({ task }) => {
    story.init(task, { tags: ['iam'] });

    story.given('SlackBot is trusted and carol is not in USERS');
    configure();

    story.when('SlackBot calls with no mcp-on-behalf-of');
    story.then('it is refused with 403');
    expect((await invoke(asBot('SlackBot'))).status).toBe(403);

    story.when('SlackBot calls on behalf of carol');
    story.then('it is refused with 403');
    expect((await invoke(asBot('SlackBot', 'carol@example.com'))).status).toBe(403);
  });
});

describe('signedHeaders', () => {
  const none = new URLSearchParams();

  test('reads SignedHeaders from the Authorization header', ({ task }) => {
    story.init(task, { tags: ['sigv4'] });

    story.given('a SigV4 Authorization header with mixed-case SignedHeaders');
    story.then('the signed header names are returned lower-cased');
    expect(
      signedHeaders({
        authorization:
          'AWS4-HMAC-SHA256 Credential=A/20260927/eu-west-2/execute-api/aws4_request, SignedHeaders=host;MCP-On-Behalf-Of;x-amz-date, Signature=abc',
        query: none,
      }),
    ).toEqual(['host', 'mcp-on-behalf-of', 'x-amz-date']);
  });

  test('reads X-Amz-SignedHeaders from a presigned URL', ({ task }) => {
    story.init(task, { tags: ['sigv4'] });

    story.given('a presigned URL with X-Amz-SignedHeaders');
    const query = new URLSearchParams('X-Amz-SignedHeaders=host%3Bmcp-on-behalf-of');

    story.then('the signed header names come from the query string');
    expect(signedHeaders({ query })).toEqual(['host', 'mcp-on-behalf-of']);
  });

  test('no signature visible means nothing is signed', ({ task }) => {
    story.init(task, { tags: ['sigv4'] });

    story.given('no SigV4 signature, or a Bearer Authorization header');
    story.then('no headers are treated as signed');
    expect(signedHeaders({ query: none })).toEqual([]);
    expect(signedHeaders({ authorization: 'Bearer abc', query: none })).toEqual([]);
  });
});

describe('roleArnOf', () => {
  test('reduces a session and a pathed role to the same role ARN', ({ task }) => {
    story.init(task, { tags: ['iam'] });

    story.given('an assumed-role session ARN and a pathed IAM role ARN for SlackBot');
    story.then('both reduce to the SlackBot role ARN');
    story.kv({ label: 'Role ARN', value: BOT_ROLE });
    expect(roleArnOf('arn:aws:sts::123456789012:assumed-role/SlackBot/s1')).toBe(BOT_ROLE);
    expect(roleArnOf('arn:aws:iam::123456789012:role/service/SlackBot')).toBe(BOT_ROLE);
  });

  test('another account is another role, and a user is not a role', ({ task }) => {
    story.init(task, { tags: ['iam'] });

    story.given('SlackBot in another account');
    story.then('it is not the trusted SlackBot role');
    expect(roleArnOf('arn:aws:sts::999999999999:assumed-role/SlackBot/s1')).not.toBe(BOT_ROLE);

    story.given('an IAM user named SlackBot');
    story.then('it has no role ARN');
    expect(roleArnOf('arn:aws:iam::123456789012:user/SlackBot')).toBeUndefined();
  });
});

describe('origins are compared whole: scheme, host and port', () => {
  const allowed = parseAllowedOrigins('https://trusted.example, http://localhost:5173/');

  test('the exact origin passes, and so does no Origin at all (a server-side client)', ({
    task,
  }) => {
    story.init(task, { tags: ['origin'] });

    story.given('ALLOWED_ORIGINS is https://trusted.example and http://localhost:5173/');
    story.then('exact matches and a missing Origin are allowed');
    story.table({
      label: 'Allowed',
      columns: ['Origin'],
      rows: [['https://trusted.example'], ['http://localhost:5173'], ['(none)']],
    });
    expect(originAllowed('https://trusted.example', allowed)).toBe(true);
    expect(originAllowed('http://localhost:5173', allowed)).toBe(true);
    expect(originAllowed(undefined, allowed)).toBe(true);
  });

  test('another scheme, port or host on the same name is refused', ({ task }) => {
    story.init(task, { tags: ['origin'] });

    story.given('ALLOWED_ORIGINS is https://trusted.example and http://localhost:5173/');
    story.then('near misses are refused');
    story.table({
      label: 'Refused',
      columns: ['Origin', 'Differs by'],
      rows: [
        ['http://trusted.example', 'scheme'],
        ['https://trusted.example:8443', 'port'],
        ['https://evil.trusted.example', 'host'],
        ['null', 'opaque origin'],
      ],
    });
    expect(originAllowed('http://trusted.example', allowed)).toBe(false);
    expect(originAllowed('https://trusted.example:8443', allowed)).toBe(false);
    expect(originAllowed('https://evil.trusted.example', allowed)).toBe(false);
    expect(originAllowed('null', allowed)).toBe(false);
  });

  test('a bare hostname in the config throws instead of admitting every scheme and port', ({
    task,
  }) => {
    story.init(task, { tags: ['origin'] });

    story.when('ALLOWED_ORIGINS holds a bare hostname or a non-http(s) scheme');
    story.then('parsing throws');
    expect(() => parseAllowedOrigins('trusted.example')).toThrow();
    expect(() => parseAllowedOrigins('ftp://trusted.example')).toThrow(/http\(s\)/);
  });

  test('bearerChallenge omits resource_metadata when there is none to point at', ({ task }) => {
    story.init(task);

    story.given('no resource metadata URL');
    story.then('the challenge is a bare invalid_token');
    expect(bearerChallenge(undefined)).toBe('Bearer error="invalid_token"');
  });
});
