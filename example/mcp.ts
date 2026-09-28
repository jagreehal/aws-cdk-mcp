// An MCP server on Lambda, the same shape as the workshop's module 06: identity is established per
// request (here, by the gateway), becomes `authInfo`, and each tool checks its own scope.
import { createMcpHandler, McpServer, type AuthInfo } from '@modelcontextprotocol/server';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { Hono } from 'hono';
import { handle, type LambdaEvent } from 'hono/aws-lambda';
import { z } from 'zod';
import { identify as identifyCaller, type GatewayAuthorizer } from '../src/runtime/identify';

export type { GatewayAuthorizer };

/** Who a trusted service may act for, and as which scopes: `USERS`, the same map as the construct's. */
export type ServiceCallers = {
  trustedRoles: string[];
  users: Record<string, string[]>;
  onBehalfOf: string | undefined;
  /** The headers the caller's SigV4 signature covers, lower-cased. */
  signedHeaders: string[];
};

/**
 * SigV4's `SignedHeaders`, from the `Authorization` header or, for a presigned URL, the
 * `X-Amz-SignedHeaders` query parameter. API Gateway has already verified the signature; this
 * says which headers it actually covered. Anything not listed could be swapped in transit.
 */
export function signedHeaders(args: { authorization?: string; query: URLSearchParams }): string[] {
  const fromHeader = /\bSignedHeaders=([^,\s]+)/.exec(args.authorization ?? '')?.[1];
  const raw = fromHeader ?? args.query.get('X-Amz-SignedHeaders') ?? '';

  return raw.toLowerCase().split(';').filter(Boolean);
}

/**
 * `arn:aws:sts::123456789012:assumed-role/Bot/session` → `arn:aws:iam::123456789012:role/Bot`,
 * and `arn:aws:iam::123456789012:role/some/path/Bot` → the same. An assumed-role ARN drops the
 * role's path, so both sides are compared without it: account and name are what identify a role.
 */
export function roleArnOf(arn: string): string | undefined {
  const session = /^arn:(aws[\w-]*):sts::(\d{12}):assumed-role\/([^/]+)\/[^/]+$/.exec(arn);

  if (session) return `arn:${session[1]}:iam::${session[2]}:role/${session[3]}`;

  const role = /^arn:(aws[\w-]*):iam::(\d{12}):role\/(?:.+\/)?([^/]+)$/.exec(arn);

  return role ? `arn:${role[1]}:iam::${role[2]}:role/${role[3]}` : undefined;
}

/**
 * A SigV4 caller becomes a user only when it is a role we trust to say who it acts for, it signed
 * that claim, and that user is in `USERS`. Any principal whose own policy allows `execute-api:Invoke` passes the
 * gateway, so the gateway's approval alone is not enough to believe `mcp-on-behalf-of`.
 */
function identifyService(
  userArn: string,
  service: ServiceCallers,
  now: number,
): AuthInfo | undefined {
  const caller = roleArnOf(userArn);
  const trusted = service.trustedRoles.flatMap((arn) => roleArnOf(arn) ?? []);

  if (!caller || !trusted.includes(caller)) return undefined;

  // SigV4 only protects the headers the signer listed: an unsigned delegation header could be
  // replaced on a captured request without breaking the signature.
  if (!service.signedHeaders.includes('mcp-on-behalf-of')) return undefined;

  const email = service.onBehalfOf?.trim().toLowerCase();
  const scopes = email ? service.users[email] : undefined;

  if (!email || !scopes) return undefined;

  // SigV4 is checked per request, so there's no token lifetime to carry; one minute is nominal.
  return { token: '', clientId: email, scopes, expiresAt: now + 60 };
}

type Env = {
  Bindings: {
    event: APIGatewayProxyEventV2 & {
      requestContext: APIGatewayProxyEventV2['requestContext'] & { authorizer?: GatewayAuthorizer };
    };
  };
};

/**
 * The gateway's verdict as the SDK wants it, or undefined: refuse the request.
 *
 * Anonymous is a mode you switch on (`ALLOW_ANONYMOUS=true`, set only with `auth: 'none'`),
 * never what a missing identity falls back to. And expiry is checked here, not just at the
 * gateway: API Gateway caches a Lambda authorizer's approval, which can outlive the token.
 */
export function identify(
  authorizer: GatewayAuthorizer | undefined,
  opts: { now: number; allowAnonymous: boolean; service: ServiceCallers },
): AuthInfo | undefined {
  if (authorizer?.iam) return identifyService(authorizer.iam.userArn, opts.service, opts.now);

  if (!authorizer?.jwt && !authorizer?.lambda && opts.allowAnonymous) {
    return { token: '', clientId: 'anonymous', scopes: [], expiresAt: opts.now + 60 };
  }

  return identifyCaller(authorizer, opts.now);
}

/** Backstop per tool: the gateway authenticates, the tool authorizes. */
const requireScope = (auth: AuthInfo | undefined, scope: string) =>
  auth?.scopes.includes(scope)
    ? undefined
    : {
        isError: true as const,
        content: [{ type: 'text' as const, text: `missing scope: ${scope}` }],
      };

export function buildServer(
  auth: AuthInfo | undefined,
  instrument: (server: McpServer) => McpServer = (server) => server,
) {
  const server = instrument(
    new McpServer(
      { name: 'aws-cdk-mcp-example', version: '0.1.0' },
      { capabilities: { tools: { listChanged: false } } },
    ),
  );

  server.registerTool(
    'whoami',
    {
      description: 'Who the gateway says the caller is, and what they may do',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => ({
      content: [
        {
          type: 'text',
          text: `${auth?.clientId}: ${auth?.scopes.join(', ') || 'no scopes'}`,
        },
      ],
    }),
  );

  server.registerTool(
    'echo',
    {
      description: 'Echo text back. Needs the `echo` scope.',
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ text }) => requireScope(auth, 'echo') ?? { content: [{ type: 'text', text }] },
  );

  return server;
}

/** email → scopes, keyed lower-case as the construct keys Google's allowlist. */
const UsersSchema = z
  .record(z.string(), z.array(z.string()))
  .transform((users) =>
    Object.fromEntries(
      Object.entries(users).map(([email, scopes]) => [email.toLowerCase(), scopes]),
    ),
  );

const parseList = (raw: string | undefined) =>
  (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

/**
 * `ALLOWED_ORIGINS` as exact origins: `https://app.example.com,http://localhost:5173`. Scheme and
 * port are part of an origin, so each entry must be a full URL; a bare hostname throws rather
 * than quietly admitting every scheme and port.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] {
  return parseList(raw).map((entry) => {
    const url = new URL(entry);

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`ALLOWED_ORIGINS entry is not an http(s) origin: ${entry}`);
    }

    return url.origin;
  });
}

/** Browsers send `Origin`; MCP clients on a server don't. A sent one must match exactly. */
export function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  return origin === undefined || allowed.includes(origin);
}

/** RFC 6750 §3 challenge, plus RFC 9728's pointer to where a client can sign in. */
export function bearerChallenge(resourceMetadataUrl: string | undefined): string {
  return resourceMetadataUrl
    ? `Bearer error="invalid_token", resource_metadata="${resourceMetadataUrl}"`
    : 'Bearer error="invalid_token"';
}

/** Optional hooks used by the separate Autotel example; the default handler imports no tracer. */
export interface HandlerTracing {
  readonly instrumentServer?: (server: McpServer) => McpServer;
  readonly prepareRequest?: (request: Request) => Promise<Request>;
}

export type HttpApiEvent = Extract<LambdaEvent, { rawPath: string }>;

/** Build once per execution environment; server identity is still established per request. */
export function createHandler(tracing: HandlerTracing = {}) {
  const mcp = createMcpHandler((ctx) => buildServer(ctx.authInfo, tracing.instrumentServer), {
    responseMode: 'json',
    maxSubscriptions: 0,
    onerror: (error) => console.error('[mcp]', error.message),
  });

  const app = new Hono<Env>().all('/mcp', async (c) => {
    if (!originAllowed(c.req.header('origin'), parseAllowedOrigins(process.env.ALLOWED_ORIGINS))) {
      return c.json({ error: 'forbidden_origin' }, 403);
    }

    // The article's "log protocol version per request": the gateway can't, so the handler does.
    console.log(
      JSON.stringify({
        protocolVersion: c.req.header('mcp-protocol-version') ?? 'legacy',
        method: c.req.header('mcp-method'),
        name: c.req.header('mcp-name'),
      }),
    );

    const authorizer = c.env.event.requestContext.authorizer;

    const authInfo = identify(authorizer, {
      now: Math.floor(Date.now() / 1000),
      allowAnonymous: process.env.ALLOW_ANONYMOUS === 'true',
      service: {
        trustedRoles: parseList(process.env.TRUSTED_CALLER_ROLES),
        users: UsersSchema.parse(JSON.parse(process.env.USERS ?? '{}')),
        onBehalfOf: c.req.header('mcp-on-behalf-of'),
        signedHeaders: signedHeaders({
          authorization: c.req.header('authorization'),
          query: new URL(c.req.url).searchParams,
        }),
      },
    });

    // Audit: a service acting for someone is the line worth keeping.
    if (authorizer?.iam) {
      console.log(JSON.stringify({ via: authorizer.iam.userArn, onBehalfOf: authInfo?.clientId }));
    }

    // A SigV4 caller didn't use OAuth, so a bearer challenge would point it the wrong way.
    if (!authInfo && authorizer?.iam) return c.json({ error: 'forbidden_caller' }, 403);

    if (!authInfo) {
      // This 401 comes from the Lambda, so unlike the gateway's own it can carry the challenge.
      c.header('www-authenticate', bearerChallenge(process.env.RESOURCE_METADATA_URL));

      return c.json({ error: 'invalid_token' }, 401);
    }

    const request = tracing.prepareRequest ? await tracing.prepareRequest(c.req.raw) : c.req.raw;

    return mcp.fetch(request, { authInfo });
  });

  return handle(app);
}

export const handler = createHandler();
