// The handler's half of auth, imported as `aws-cdk-mcp/runtime`. Types only from the rest of the
// package, so a handler bundle pulls in no aws-cdk-lib.
import type { McpIdentity } from './identity';

/** What the gateway attaches at `event.requestContext.authorizer`: `lambda`, `jwt` or `iam`. */
export type GatewayAuthorizer = {
  /** API Gateway may deliver context numbers as strings, so `exp` is parsed. */
  lambda?: Partial<Omit<McpIdentity, 'exp'>> & { exp?: number | string };
  // `scopes` is null unless the route has authorizationScopes.
  jwt?: { claims: Record<string, string | number | boolean | string[]>; scopes: string[] | null };
  // API Gateway's SigV4 verdict. For a Lambda caller, `userArn` is its assumed-role session.
  iam?: {
    accessKey: string;
    accountId: string;
    callerId: string;
    cognitoIdentity: null;
    principalOrgId: null;
    userArn: string;
    userId: string;
  };
};

/** Structurally the MCP SDK's `AuthInfo`, without depending on the SDK. */
export type CallerAuthInfo = {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
};

/**
 * A `lambda` or `jwt` identity as AuthInfo, or undefined: refuse. Expiry is checked here too,
 * because API Gateway caches a Lambda authorizer's approval, which can outlive the token.
 * IAM callers are refused: whom a signed service acts for is the handler's decision.
 */
export function identify(
  authorizer: GatewayAuthorizer | undefined,
  now: number,
): CallerAuthInfo | undefined {
  const { jwt, lambda } = authorizer ?? {};

  const caller = jwt
    ? {
        id: String(jwt.claims.email ?? jwt.claims.sub ?? ''),
        // API Gateway parses the scope claim when the route has authorizationScopes.
        scopes: jwt.scopes ?? String(jwt.claims.scope ?? '').split(' '),
        exp: Number(jwt.claims.exp),
      }
    : lambda
      ? {
          id: lambda.email ?? lambda.sub ?? '',
          scopes: (lambda.scopes ?? '').split(' '),
          exp: Number(lambda.exp),
        }
      : undefined;

  if (!caller?.id || !Number.isFinite(caller.exp) || caller.exp <= now) return undefined;

  return {
    token: '', // verified and dropped at the gateway; nothing here forwards it
    clientId: caller.id,
    scopes: caller.scopes.filter(Boolean),
    expiresAt: caller.exp,
  };
}
