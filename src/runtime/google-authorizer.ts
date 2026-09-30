// API Gateway (HTTP API) Lambda authorizer: a Google access token in, an Identity out.
// Everything from outside (env, Google's JSON) is parsed at the boundary, then decided on.
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { z } from 'zod';

const AuthorizerConfigSchema = z.object({
  GOOGLE_CLIENT_IDS: z
    .string()
    .transform((raw) =>
      raw
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string()).min(1)),
  HOSTED_DOMAIN: z.string().min(1),
  USERS: z
    .string()
    .transform((raw) => z.record(z.string(), z.array(z.string())).parse(JSON.parse(raw))),
});

export type AuthorizerConfig = {
  clientIds: string[];
  hostedDomain: string;
  users: Record<string, string[]>;
};

/** `oauth2.googleapis.com/tokeninfo`: which client the token was minted for, and until when. */
const TokenInfoSchema = z.object({ aud: z.string().optional(), exp: z.string().optional() });

export type TokenInfo = z.infer<typeof TokenInfoSchema>;

/** `openidconnect.googleapis.com/v1/userinfo`: who it belongs to. */
const UserInfoSchema = z.object({
  sub: z.string().optional(),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  hd: z.string().optional(),
});

export type UserInfo = z.infer<typeof UserInfoSchema>;

/**
 * What any Lambda authorizer hands the MCP handler, as its simple-response `context`.
 * `exp` (epoch seconds) travels with it because API Gateway caches the verdict: the handler
 * refuses an identity whose token has expired, however recently the gateway approved it.
 */
export type Identity = { email: string; sub: string; scopes: string; exp: number };

/** Pure: every rule that decides access, so a test fails when one is removed. */
export function decide(
  args: { tokenInfo: TokenInfo; userInfo: UserInfo; now: number },
  config: AuthorizerConfig,
): Identity | undefined {
  const { tokenInfo, userInfo, now } = args;
  const exp = Number(tokenInfo.exp);

  // Audience: a valid Google token minted for some other app is not a token for this server.
  // It is not an MCP resource audience (RFC 8707): Google cannot mint one. See README.
  if (tokenInfo.aud === undefined || !config.clientIds.includes(tokenInfo.aud)) return undefined;

  if (!Number.isFinite(exp) || exp <= now) return undefined;

  // Google's guidance: `hd`, not the email suffix, proves a Workspace account.
  if (userInfo.hd !== config.hostedDomain) return undefined;

  if (userInfo.email_verified !== true || !userInfo.email || !userInfo.sub) return undefined;

  // Keys are Google `sub`s or emails. A `sub` survives an email rename; an email is easier to read.
  // `*` is everyone in `hostedDomain` (checked above); a named entry wins over it.
  const scopes =
    config.users[userInfo.sub] ?? config.users[userInfo.email.toLowerCase()] ?? config.users['*'];

  if (!scopes) return undefined;

  return { email: userInfo.email.toLowerCase(), sub: userInfo.sub, scopes: scopes.join(' '), exp };
}

/** The slice of `fetch` the authorizer uses, so a test fake needs no cast. */
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function authorize(
  args: { authorization?: string },
  deps: { config: AuthorizerConfig; fetch: Fetch },
): Promise<Identity | undefined> {
  const token = args.authorization?.match(/^Bearer (\S+)$/i)?.[1];

  if (!token) return undefined;

  // One retry on a network failure, never on an HTTP answer: a keep-alive socket left over from a
  // previous invocation can be closed by Google while Lambda is frozen, and the first request on
  // it fails (`UND_ERR_SOCKET`). Both calls are idempotent reads. Without this, a valid user is
  // refused, and API Gateway caches that refusal for the token.
  const ask = (url: string, init?: RequestInit) =>
    deps.fetch(url, init).catch(() => deps.fetch(url, init));

  // Google access tokens are opaque, so Google is asked rather than a signature checked.
  const [tokenRes, userRes] = await Promise.all([
    ask(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`),
    ask('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${token}` },
    }),
  ]);

  // Expired or revoked tokens come back 400/401.
  if (!tokenRes.ok || !userRes.ok) return undefined;

  // A shape Google never sends is a refusal, not a crash.
  const tokenInfo = TokenInfoSchema.safeParse(await tokenRes.json());
  const userInfo = UserInfoSchema.safeParse(await userRes.json());

  if (!tokenInfo.success || !userInfo.success) return undefined;

  return decide(
    { tokenInfo: tokenInfo.data, userInfo: userInfo.data, now: Math.floor(Date.now() / 1000) },
    deps.config,
  );
}

/** The construct's environment, parsed once: a bad deploy fails at cold start, not per request. */
export function parseConfig(env: NodeJS.ProcessEnv): AuthorizerConfig {
  const parsed = AuthorizerConfigSchema.parse(env);

  return {
    clientIds: parsed.GOOGLE_CLIENT_IDS,
    hostedDomain: parsed.HOSTED_DOMAIN,
    users: parsed.USERS,
  };
}

let config: AuthorizerConfig | undefined;

export async function handler(
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerWithContextResult<Identity | undefined>> {
  try {
    config ??= parseConfig(process.env);

    const identity = await authorize(
      { authorization: event.headers?.authorization },
      { config, fetch },
    );

    return { isAuthorized: identity !== undefined, context: identity };
  } catch (error) {
    // Fail closed: Google unreachable means nobody gets in, not everybody.
    console.error('[authorizer]', error);

    return { isAuthorized: false, context: undefined };
  }
}
