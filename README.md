# aws-cdk-mcp

A CDK construct for a remote MCP server on the **2026-07-28** protocol: one HTTP API in front of your Lambda.

```ts
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { StatelessMcpServer } from 'aws-cdk-mcp';

new StatelessMcpServer(this, 'Mcp', {
  handler: new NodejsFunction(this, 'McpHandler', { entry: 'src/mcp.ts' }),
  auth: {
    type: 'googleWorkspace',
    clientIds: ['123-web….apps.googleusercontent.com', '123-desktop….apps.googleusercontent.com'],
    hostedDomain: 'example.com',
    users: {
      'alice@example.com': ['payments:read'],
      'bob@example.com': ['payments:read', 'payments:refund'],
    },
  },
});
```

The 2026-07-28 protocol has no sessions. `StatelessMcpServer` creates an HTTP API, a `$default` stage, and routes into your Lambda. It creates no sticky routing, session table, or Redis. Any invocation can answer any request. You keep application state: a tool returns an id, the model sends that id back, and you look it up in your own store.

Every test is an executable story. Read them as a behaviour spec at [jagreehal.github.io/aws-cdk-mcp](https://jagreehal.github.io/aws-cdk-mcp/), rebuilt from `main` on each push.

The shape matches the AWS post [MCP went stateless](https://aws.amazon.com/blogs/architecture/mcp-went-stateless-is-your-aws-mcp-server-deployment-well-architected/).

Requires Node.js 24 or later. Peer dependencies: `aws-cdk-lib` ≥ 2.252.0 (the first release with `Validations.acknowledge`) and `constructs` ^10.5.0. The package depends on `zod` to validate API-key configuration at synth. License: MIT.

```ts
import {
  StatelessMcpServer,
  type McpAuth,
  type McpApiKey,
  type McpApiKeyIdentity,
  type McpIdentity,
  type StatelessMcpServerProps,
} from 'aws-cdk-mcp';
```

`pnpm build` writes `dist/` from `src/` and the runtime bundles to `lambda/`. The worked server in `example/` stays in this repository. You write your own handler Lambda and pass it as `handler`.

The construct's own Lambdas ship pre-bundled in the package, so synth needs neither `esbuild` nor Docker for them. `none` and `iam` create no construct-owned function. A `lambda` authorizer is your function. Metadata for `jwt`, and for `lambda` when you set `authorizationServer`, adds one more.

## Resources

```
MCP client ──POST /mcp──▶ HTTP API ($default stage: throttle + JSON access logs)
                            │
                            ├─ authorizer        none | IAM | API key | JWT | your Lambda | Google Workspace
                            ├─ POST|GET|DELETE /mcp ──▶ your Lambda
                            └─ GET /.well-known/oauth-protected-resource[/mcp] ──▶ RFC 9728 metadata
```

The API name is `${stackName}-${constructId}`. A stack `jag-aws-cdk-mcp` and a construct id `Mcp` produce an API named `jag-aws-cdk-mcp-Mcp`. The API description is `Stateless MCP server (protocol 2026-07-28)`. CDK's default stage is off (`createDefaultStage: false`). The construct adds a stage with construct id `Stage`, stage name `$default`, and `autoDeploy: true`. The id is `Stage` because CDK drops the id `Default` from logical ids, and that would collide with the API.

`POST` is the 2026-07-28 call. `GET` and `DELETE` are the 2025 session operations. The construct routes them to your Lambda so the SDK answers `405`, as that spec requires. Without the routes the gateway would answer `404`.

The stage throttle covers `/mcp` and the metadata routes. The access log covers the same stage.

There is one CloudWatch alarm and one stack output. See [Values on the construct](#values-on-the-construct).

## Props

| Prop          | Default                              |                                                                                                  |
| ------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `handler`     | required                             | Your MCP Lambda. Return JSON. API Gateway buffers the body.                                      |
| `auth`        | required                             | You pick a mode. Omitting it fails the build.                                                    |
| `path`        | `/mcp`                               | Leading slash included. Metadata uses this path as a suffix.                                     |
| `publicUrl`   | execute-api endpoint                 | Full HTTPS endpoint clients use, including a mapping prefix. No trailing slash.                  |
| `metadataApi` | MCP API                              | API mapped at the public domain root for OAuth discovery. Required with an OAuth mapping prefix. |
| `throttle`    | `{ rateLimit: 50, burstLimit: 100 }` | `ThrottleSettings` on the stage, in requests per second.                                         |
| `accessLogs`  | one month, deleted with the stack    | Pass your own `ILogGroup` for production. See [Production](#production).                         |

`path` is concatenated onto the stage URL and registered as the route path. Your handler's route must be the same path. The example Hono app listens on `/mcp` and the example stack leaves `path` at the default.

## Values on the construct

| Member                 |                                                                                                                       |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `url`                  | MCP endpoint, for example `https://abc.execute-api.eu-west-1.amazonaws.com/mcp`. A CloudFormation token until deploy. |
| `resourceMetadataUrl`  | RFC 9728 URL when this server publishes metadata. Undefined for `none`, `iam`, and `apiKey`.                          |
| `api`                  | The `HttpApi`. Add your own routes, a custom domain, or `metricClientError()`.                                        |
| `serverErrorAlarm`     | Alarm with no action until you add one.                                                                               |
| `grantInvoke(grantee)` | `execute-api:Invoke` on the `POST`, `GET`, and `DELETE` routes. Requires IAM auth. Other modes throw.                 |

`stage` exposes the auto-deploying `$default` stage. Pass `server.stage` to `ApiMapping` when attaching a custom domain.

Deploy prints `url` as a stack output with id `Url` (the construct path plus `Url`, so construct `Mcp` shows up as `McpUrl`).

Without `publicUrl`, `resourceMetadataUrl` is built from the execute-api stage URL:

```
${stageUrl}/.well-known/oauth-protected-resource${path}
```

Without `publicUrl`, the metadata Lambda sets `resource` from the request's `domainName` and the MCP route. With `publicUrl`, `url` and the metadata's `resource` use that exact endpoint, and `resourceMetadataUrl` uses its origin and full path. Pass `server.resourceMetadataUrl` to your handler for its bearer challenge. The example does this when metadata is available.

### Custom domains with path mappings

For a domain mapped at its root, set `publicUrl: 'https://docs.example.com/mcp'` and create an `ApiMapping` with `api: server.api` and `stage: server.stage`. The discovery routes stay on that API.

For an endpoint under a mapping prefix, such as `https://docs.example.com/docs/mcp`, clients discover OAuth at `https://docs.example.com/.well-known/oauth-protected-resource/docs/mcp`. An API mapped only at `/docs` cannot receive that request. Supply a separate `metadataApi` mapped at the domain root, alongside the `/docs` MCP mapping:

```ts
import { ApiMapping, DomainName, HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';

// certificate is an ACM certificate for docs.example.com in the API's region.
const domain = new DomainName(this, 'DocsDomain', {
  domainName: 'docs.example.com',
  certificate,
});
const metadataApi = new HttpApi(this, 'DocsDiscovery');
const server = new StatelessMcpServer(this, 'Mcp', {
  handler,
  auth: {
    type: 'jwt',
    issuer: 'https://auth.example.com',
    audience: ['https://docs.example.com/docs/mcp'],
    requiredScopes: ['mcp'],
  },
  publicUrl: 'https://docs.example.com/docs/mcp',
  metadataApi,
});

new ApiMapping(this, 'DiscoveryMapping', { api: metadataApi, domainName: domain });
new ApiMapping(this, 'DocsMapping', {
  api: server.api,
  stage: server.stage,
  domainName: domain,
  apiMappingKey: 'docs',
});
```

You own the domain mappings and the DNS record that points at API Gateway. API Gateway strips `/docs` and sends `/mcp` to your handler, so use the full `publicUrl` as the token audience. The construct adds two unauthenticated discovery routes to the root API, including the `/docs/mcp` suffix, even when that API has a default authorizer. An existing root-mapped API works if it has no discovery routes of its own. The root metadata route describes one resource, so give each server that needs it its own domain.

`serverErrorAlarm` uses `api.metricServerError()` with period 5 minutes, statistic `Sum`, threshold 5, one evaluation period, `GREATER_THAN_OR_EQUAL_TO_THRESHOLD`, and `treatMissingData: NOT_BREACHING`. The description is `${url} returned 5xx`. It counts handler errors, timeouts, and authorizers that throttle or crash. Authorizer refusals are 401 or 403 and do not trip it. A Google outage that locks callers out shows up as a rise in 4xx. Alarm on `server.api.metricClientError()` if you want that signal too.

```ts
server.serverErrorAlarm.addAlarmAction(new SnsAction(opsTopic));
```

## Access logs

Each line is JSON:

| Field       | Source                           | Filled by                                                 |
| ----------- | -------------------------------- | --------------------------------------------------------- |
| `requestId` | `$context.requestId`             | the gateway                                               |
| `ip`        | `$context.identity.sourceIp`     | the gateway                                               |
| `route`     | `$context.routeKey`              | the gateway                                               |
| `status`    | `$context.status`                | the gateway                                               |
| `latencyMs` | `$context.responseLatency`       | the gateway                                               |
| `email`     | `$context.authorizer.email`      | Google, and a Lambda authorizer that sets `email`         |
| `clientId`  | `$context.authorizer.sub`        | Google, API keys, and a Lambda authorizer that sets `sub` |
| `jwtSub`    | `$context.authorizer.claims.sub` | `jwt`                                                     |
| `iamCaller` | `$context.identity.userArn`      | `iam`                                                     |
| `authError` | `$context.authorizer.error`      | a failed authorizer                                       |

Each mode fills its own caller fields and leaves the others empty. The gateway cannot log request headers, so the protocol version is absent here. The example handler logs it. See [The handler you write](#the-handler-you-write).

## Auth

You pass one `auth` object. The construct has no default mode.

| `auth.type`       | Who checks the caller                          | The handler reads                  | Metadata                         |
| ----------------- | ---------------------------------------------- | ---------------------------------- | -------------------------------- |
| `none`            | nobody                                         | nothing                            | no                               |
| `apiKey`          | built-in Lambda authorizer, header `x-api-key` | `requestContext.authorizer.lambda` | no                               |
| `iam`             | API Gateway, SigV4                             | `requestContext.authorizer.iam`    | no                               |
| `jwt`             | API Gateway: issuer, audience, expiry, scopes  | `requestContext.authorizer.jwt`    | yes                              |
| `lambda`          | your authorizer Lambda                         | `requestContext.authorizer.lambda` | if you set `authorizationServer` |
| `googleWorkspace` | built-in Lambda authorizer                     | `requestContext.authorizer.lambda` | yes                              |

Lambda authorizers use the HTTP API simple response, `{ isAuthorized, context }`. Context values must be strings, numbers, or booleans. API Gateway rejects nested objects and arrays, so `scopes` is one space-separated string.

`McpIdentity` is that context:

```ts
interface McpIdentity {
  sub: string;
  email?: string;
  scopes: string; // space-separated
  exp: number; // epoch seconds
}
```

API Gateway caches a Lambda authorizer verdict. Your handler still checks `exp`, because the cache can outlive the token. `apiKey` sets the cache TTL to 0. `googleWorkspace` and `lambda` default to 5 minutes.

### `none`

```ts
new StatelessMcpServer(this, 'Mcp', { handler, auth: { type: 'none' } });
```

The `/mcp` routes have no authorizer. The construct acknowledges cdk-nag `AwsSolutions-APIG4` on those routes because you chose this mode. Use it for a throwaway stack. The example handler treats callers as anonymous when `ALLOW_ANONYMOUS` is the string `true`. `example/app.ts` sets that for this mode.

### `apiKey`

Machine clients send `x-api-key`. You store a SHA-256 hash per key, plus the client id and scopes that hash unlocks. The raw key stays out of the template and out of the Lambda environment.

```ts
auth: {
  type: 'apiKey',
  keys: [{ sha256: keyHash, clientId: 'team-bot', scopes: ['echo'], expiresAt }],
}
```

`McpApiKey` / the `keys` entry:

| Field       | Rule                                                                |
| ----------- | ------------------------------------------------------------------- |
| `sha256`    | 64 hex characters. Upper case is lowercased at synth.               |
| `clientId`  | Non-empty after trim. Becomes `sub`.                                |
| `scopes`    | List of tokens with no whitespace. An empty list grants no scopes.  |
| `expiresAt` | Optional epoch seconds. The key is refused when `expiresAt <= now`. |

Synth throws when `keys` is empty, a hash is the wrong shape, two entries share a hash, a scope contains whitespace, or the authorizer's environment, serialized as JSON, is over Lambda's 4 KB limit. Past that, use `lambda` with a secret store and `identitySource: ['$request.header.x-api-key']`.

Generate the key on your machine. At least 32 random bytes. Share the raw key through your secret process. Put the hash in CDK configuration.

```js
import { createHash, randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('hex');
const keyHash = createHash('sha256').update(key).digest('hex');
```

The authorizer reads `event.headers['x-api-key']` (API Gateway lowercases header names). It refuses a missing value, an empty value, anything shorter than 32 characters, any whitespace, a comma (so a list of keys in one header fails), an unknown hash, and an expired key. The compare is SHA-256 then `timingSafeEqual`. A match returns:

```ts
{ sub: clientId, scopes: scopes.join(' '), exp }
```

`exp` is `min(expiresAt ?? now + 60, now + 60)`. The identity lasts at most 60 seconds, and less when the key expires sooner. The context has `sub`, `scopes`, and `exp`. That return type is `McpApiKeyIdentity`. The hash and the raw key stay out of it. The example handler uses `sub` as the caller id when `email` is absent.

Verdict caching is off (`AuthorizerResultTtlInSeconds: 0`). After you deploy a removed hash or a changed scope list, the next request sees it. For rotation, deploy the old hash and the new hash, move clients, then remove the old hash.

A malformed `API_KEYS` value returns `{ isAuthorized: false, context: undefined }` and logs `[api-key-authorizer] invalid configuration`. That log line does not include the header.

This mode is a Lambda authorizer on the `x-api-key` header. It publishes no OAuth metadata, and it creates no REST API usage plan.

### `iam`

For a caller with no browser, such as a Slack bot's Lambda in the same account. The caller signs with its role. You do not store a shared secret for the gateway.

```ts
const server = new StatelessMcpServer(this, 'McpForBots', {
  handler,
  auth: { type: 'iam' },
});

server.grantInvoke(slackBotFn); // any IGrantable
```

`grantInvoke` adds `execute-api:Invoke` on `POST`, `GET`, and `DELETE` of `path`. Calling it on a `googleWorkspace`, `jwt`, `apiKey`, `lambda`, or `none` server throws, because `HttpRoute.grantInvoke` requires an IAM authorizer.

The gateway checks the signature. Your handler decides which person the bot represents. A principal whose own policy allows `execute-api:Invoke` on these routes gets through the gateway. The example handler trusts that caller after you configure delegation. See [Service callers in the example](#service-callers-in-the-example).

The handler receives `requestContext.authorizer.iam`: `accessKey`, `accountId`, `callerId`, `cognitoIdentity`, `principalOrgId`, `userArn`, `userId`. For a Lambda caller, `userArn` is the assumed-role session ARN.

To serve Claude connectors and a bot from the same tools, create two `StatelessMcpServer`s on one `handler`: one `googleWorkspace` or `jwt`, one `iam`. The example app deploys a single mode from `MCP_AUTH`.

### `jwt`

Any authorization server that mints JWT access tokens for this MCP server: Cognito (with Google as an upstream identity provider), Okta, Entra, Auth0, better-auth's OIDC provider. API Gateway checks the token before your Lambda runs.

```ts
auth: {
  type: 'jwt',
  issuer: 'https://idp.example.com',
  audience: ['mcp'],
  requiredScopes: ['mcp:tools'],
  scopes: ['mcp:tools', 'payments:read'], // optional; advertised in metadata
}
```

| Field            | Rule                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| `issuer`         | JWT authorizer issuer. Also `authorization_servers` in the metadata. |
| `audience`       | `jwtAudience`. Must identify this MCP server and nothing else.       |
| `requiredScopes` | At least one. Route `authorizationScopes`. Synth throws when empty.  |
| `scopes`         | Advertised as `scopes_supported`. Defaults to `requiredScopes`.      |

API Gateway treats `authorizationScopes` as OR: the token's `scope` or `scp` claim must contain at least one listed scope. An ID token has no scope claim, so this list keeps ID tokens out. `audience` is the MCP spec's rule that a server accepts tokens issued for itself. Cognito checks `client_id` rather than `aud`. For a Cognito authorizer, put the app client id in `audience`.

Claims arrive at `requestContext.authorizer.jwt.claims`. When the route has `authorizationScopes`, API Gateway also sets `requestContext.authorizer.jwt.scopes` to the scopes it parsed. The example prefers `jwt.scopes`, then `claims.scope`.

### `lambda`

Bring your own authorizer: token introspection, a session cookie, a secret-store API key.

```ts
auth: {
  type: 'lambda',
  authorizer: myAuthorizerFn,
  authorizationServer: 'https://auth.example.com', // omit to skip metadata
  scopes: ['openid', 'payments:read'], // default ['openid']
  cacheTtl: Duration.minutes(5), // default 5 minutes; Duration.seconds(0) disables
  identitySource: ['$request.header.Authorization'], // the default
}
```

Return `{ isAuthorized: true, context }` with `context` an `McpIdentity` (`sub`, space-separated `scopes`, `exp`, optional `email`). The construct wires `HttpLambdaAuthorizer` with `HttpLambdaResponseType.SIMPLE`. Your function's log group, tracing, and cdk-nag findings stay yours. The construct does not wrap your function in its own role.

Set `authorizationServer` to the issuer clients should use. The construct then publishes RFC 9728 metadata and sets `resourceMetadataUrl`. Omit it and those routes are absent. `scopes` is the metadata list. It defaults to `['openid']`. It is not applied as a route scope check. Your authorizer and your handler enforce scopes.

`cacheTtl` is `resultsCacheTtl`. A caller you remove keeps the cached verdict until that TTL ends. The default is 5 minutes.

`identitySource` is the cache key. The default is the `Authorization` header. For an API-key style authorizer, set `['$request.header.x-api-key']`.

### `googleWorkspace`

Google says who the caller is. The `users` map says what they may do. There is no Cognito user pool in this mode.

```ts
auth: {
  type: 'googleWorkspace',
  clientIds: ['web-client.apps.googleusercontent.com', 'desktop-client.apps.googleusercontent.com'],
  hostedDomain: 'example.com',
  users: {
    'Alice@example.com': ['echo'],
    '109876543210987654321': ['echo', 'admin'], // a Google sub
  },
}
```

Synth throws when `clientIds` is empty, `hostedDomain` is blank, `users` has no entries, or `users` is too big for the Lambda environment (see below). `cacheTtl` sets how long API Gateway caches a verdict per token (default 5 minutes). Keys are emails or Google `sub`s. Emails are lowercased before they are stored, so `Alice@example.com` is stored as `alice@example.com`. Google recommends `sub` because an email can change and a `sub` does not. You can mix both. A `sub` match wins. A `*` key admits everyone in `hostedDomain` with its scopes, and a named entry wins over it: `{"*":["payments:read"],"cfo@example.com":["payments:read","payments:write"]}`. The `iam` example's `mcp-on-behalf-of` does not honour `*`: the bot could name any address.

The authorizer is a Lambda the construct creates. It reads `Authorization`, expects `Bearer <opaque access token>` (case-insensitive scheme, one non-whitespace token), and asks Google in parallel:

- `GET https://oauth2.googleapis.com/tokeninfo?access_token=…` for `aud` and `exp`
- `GET https://openidconnect.googleapis.com/v1/userinfo` with the same bearer token, for `sub`, `email`, `email_verified`, and `hd`

The authorizer retries a network error on either call once. An HTTP status is final. The retry covers a keep-alive socket Google closed while the Lambda was frozen (`UND_ERR_SOCKET`). Both calls are idempotent reads. Without the retry, the authorizer refuses a valid user, and API Gateway caches that refusal for the token (5 minutes, the `lambda` default).

The authorizer refuses the token unless all of these hold:

- `aud` is one of `clientIds`
- `exp` parses as a finite number and is greater than now
- `hd` equals `hostedDomain` (Google's guidance: the email suffix is not proof of a Workspace account)
- `email_verified` is `true`, and both `email` and `sub` are present
- `sub`, or the lowercased email, is a key in `users`, or `users` has a `*` key

It then returns:

```ts
{ email, sub, scopes: scopes.join(' '), exp }
```

`email` is lowercased. A tokeninfo or userinfo body that fails the schema is a refusal, as is any non-OK HTTP status (expired and revoked tokens come back 400 or 401). If Google is unreachable, or the environment fails to parse, the handler catches the error, logs `[authorizer]` plus the error, and returns `isAuthorized: false`. The tokeninfo URL contains the access token. A network error logged by `fetch` can include that URL.

The authorizer environment is `GOOGLE_CLIENT_IDS` (comma-separated), `HOSTED_DOMAIN`, and `USERS` (JSON). Lambda caps all environment variables at 4 KB, counted across all three together, so synth throws when the environment serialized as JSON passes 4,096 bytes (about 100 people with a couple of client ids). Past that, move the allowlist to SSM or AppConfig and use `auth.type: 'lambda'`. Anyone who can call `lambda:GetFunctionConfiguration` or `cloudformation:GetTemplate` on the stack can read the emails. Removing a person takes a redeploy, and their cached verdict lasts up to `cacheTtl`. A token that expires sooner is refused by the handler's `exp` check.

Metadata points at `https://accounts.google.com` with scopes `openid` and `email`.

> Google cannot mint a token whose audience is this MCP resource (RFC 8707). The `clientIds` check is as close as this mode gets, and it holds when that OAuth client is dedicated to this one server. For a spec-compliant server, use `jwt` with an authorization server that issues tokens for this resource and treats Google as its identity provider.

Google setup for the example is in [Google Cloud](#google-cloud).

## Protected-resource metadata

Published for `jwt`, for `googleWorkspace`, and for `lambda` when `authorizationServer` is set. Two unauthenticated `GET` routes on `metadataApi` when supplied, otherwise on `api`, because clients try the path-suffixed URL first and then the root (RFC 9728). The suffix is `publicUrl`'s full pathname when configured, otherwise `path`:

- `/.well-known/oauth-protected-resource${path}`
- `/.well-known/oauth-protected-resource`

The construct acknowledges cdk-nag `AwsSolutions-APIG4` on both routes: clients read this before they have a token.

The Lambda answers 200, `content-type: application/json`, `cache-control: max-age=3600`:

```json
{
  "resource": "https://<request domain><path>",
  "authorization_servers": ["<issuer>"],
  "scopes_supported": ["openid", "email"],
  "bearer_methods_supported": ["header"]
}
```

`resource` uses `PUBLIC_RESOURCE_URL` when `publicUrl` is configured. Otherwise it uses `event.requestContext.domainName` plus `MCP_PATH`. `authorization_servers` is the JWT `issuer`, the Lambda `authorizationServer`, or `https://accounts.google.com`. `scopes_supported` is the `scopes` list you configured, split on spaces.

HTTP APIs cannot add headers to the 401 they emit when an authorizer refuses a call. Clients fall back to these well-known URLs. Your handler's own 401 can still send `WWW-Authenticate`. The example does. See [The handler you write](#the-handler-you-write).

## Lambdas owned by the construct

`apiKey` creates `ApiKeyAuthorizer`. `googleWorkspace` creates `GoogleAuthorizer`. Metadata creates `ProtectedResourceMetadata`. Each is a `lambda.Function`:

| Setting      | Value                                   |
| ------------ | --------------------------------------- |
| Runtime      | Node.js 24                              |
| Architecture | ARM64                                   |
| Memory       | 256 MB                                  |
| Timeout      | 5 seconds                               |
| Log group    | one month, `RemovalPolicy.DESTROY`      |
| Role         | `logGroup.grantWrite` on that log group |

The construct creates that role itself, with log-group write on this function's group. The code is `lambda/<name>/index.js` in the published package, bundled from `src/runtime/<name>.ts` (with `zod` for the two authorizers) by `pnpm build`. Tests bundle it first too, so they synth what consumers deploy.

cdk-nag on these functions:

| Rule                       | Reason                                                                       |
| -------------------------- | ---------------------------------------------------------------------------- |
| `Serverless-LambdaDLQ`     | API Gateway waits for the response. A DLQ receives failed async invocations. |
| `Serverless-LambdaTracing` | These handlers log to CloudWatch. You configure tracing on your handler.     |

A Google authorizer must finish both Google calls inside 5 seconds.

## The handler you write

The gateway authenticates. Your Lambda authorizes tools, checks expiry, and speaks MCP. `example/mcp.ts` is the reference in this repo. It is not part of the published construct. Each rule below has a test that fails if you remove the rule.

The published `aws-cdk-mcp/runtime` entry point covers the common case. It imports no aws-cdk-lib, so it is safe in a handler bundle:

```ts
import { identify } from 'aws-cdk-mcp/runtime';

const authInfo = identify(event.requestContext.authorizer, Math.floor(Date.now() / 1000));
```

It reads `jwt` and `lambda` identities, re-checks `exp`, and returns the SDK's `AuthInfo` shape or `undefined`. It refuses IAM and anonymous callers: those are policy decisions the handler makes itself, as the example does below.

It reads three authorizer shapes, exported as `GatewayAuthorizer`. A handler that reads `lambda` context and ignores `jwt` lets a JWT caller skip the scope checks.

```ts
type GatewayAuthorizer = {
  lambda?: Partial<Omit<McpIdentity, 'exp'>> & { exp?: number | string };
  jwt?: { claims: Record<string, string | number | boolean | string[]>; scopes: string[] | null };
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
```

`identify` in the example handles IAM and anonymous callers, then hands the rest to the runtime `identify`:

1. If `authorizer.iam` is set, delegation rules apply. See [Service callers in the example](#service-callers-in-the-example).
2. Else if `authorizer.jwt` is set, the caller id is `claims.email`, then `claims.sub`. Scopes are `jwt.scopes`, or `claims.scope` split on spaces. `exp` is `claims.exp`.
3. Else if `authorizer.lambda` is set, the caller id is `email`, then `sub`. Scopes are `scopes` split on spaces. `exp` is `exp`.
4. If none of those exist and `ALLOW_ANONYMOUS` is the string `true`, the caller is `{ clientId: 'anonymous', scopes: [], expiresAt: now + 60 }`.
5. Otherwise the caller is refused.

The example refuses a present caller with an empty id, a non-numeric `exp`, or `exp <= now`. The token string on the SDK `AuthInfo` is `''`. The gateway checked the credential, and the example leaves it off the SDK identity.

Anonymous access is the `none` mode in the example stack. `example/app.ts` sets `ALLOW_ANONYMOUS` to `"true"` for `MCP_AUTH=none`, and to `"false"` for the other modes. A missing identity stays a 401 unless that variable is `"true"`.

Responses from the example, after the origin check:

| Situation                         | Status | Body                              | `WWW-Authenticate`                                                                                         |
| --------------------------------- | ------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Origin` not in `ALLOWED_ORIGINS` | 403    | `{ "error": "forbidden_origin" }` | absent                                                                                                     |
| IAM caller that fails delegation  | 403    | `{ "error": "forbidden_caller" }` | absent. A bearer challenge would send a SigV4 caller toward OAuth.                                         |
| No caller, or expired caller      | 401    | `{ "error": "invalid_token" }`    | `Bearer error="invalid_token"` plus `resource_metadata="<RESOURCE_METADATA_URL>"` when that env var is set |

There is no `insufficient_scope` challenge. A tool the caller may not run returns an MCP tool result with `isError: true` and text `missing scope: <scope>`.

`ALLOWED_ORIGINS` is a comma-separated list of origins: `https://app.example.com,http://localhost:5173`. Each entry must be an `http:` or `https:` URL. A bare hostname throws. `ftp:` throws. A trailing path is dropped via `URL.origin`, so `http://localhost:5173/` is stored as `http://localhost:5173`. A request with no `Origin` header passes (a server-side client). A sent `Origin` must equal one stored origin: scheme, host, and port. `http://trusted.example`, `https://trusted.example:8443`, `https://evil.trusted.example`, and the string `null` all fail against `https://trusted.example`. The example stack does not set `ALLOWED_ORIGINS`. With it unset, any sent `Origin` is refused and a missing `Origin` still passes. The construct does not configure CORS on the HTTP API, and the example does not add `Access-Control-Allow-Origin`.

On each `/mcp` request that passes the origin check, the example logs:

```json
{ "protocolVersion": "2026-07-28", "method": "tools/call", "name": "whoami" }
```

`protocolVersion` is the `mcp-protocol-version` header, or the string `legacy` when the header is absent. `method` is `mcp-method`. `name` is `mcp-name`. That is the article's "log protocol version per request" step. The gateway cannot put those headers in the access log.

For an IAM caller the example also logs `{ "via": "<userArn>", "onBehalfOf": "<clientId or absent>" }`, including when delegation fails.

SDK settings in the example, because API Gateway buffers the response:

- `responseMode: 'json'`
- `capabilities.tools.listChanged: false`
- `maxSubscriptions: 0`
- `onerror` logs `[mcp]` and `error.message`

With `listChanged: false` and `maxSubscriptions: 0`, `server/discover` does not advertise `tools.listChanged`, and `subscriptions/listen` returns a JSON-RPC error in a normal response. The content type is not `text/event-stream`. The SDK also implements `server/discover`, `resultType`, private cache defaults (`ttlMs: 0`, `cacheScope: "private"`), and header/body consistency (`-32020` when `mcp-method` or `mcp-name` disagree with the body).

The example server is named `aws-cdk-mcp-example` version `0.1.0`. Tools:

| Tool     | Scope  | Input              | Result                                                                               |
| -------- | ------ | ------------------ | ------------------------------------------------------------------------------------ |
| `whoami` | none   | `{}`               | text `<clientId>: <scopes joined by comma, or "no scopes">`. `readOnlyHint`.         |
| `echo`   | `echo` | `{ text: string }` | the text, or `isError` with `missing scope: echo`. `readOnlyHint`, `idempotentHint`. |

A first request may be `tools/call` with no prior `initialize`. The protocol is stateless, and the example answers it.

The example handler is a `NodejsFunction`: Node.js 24, ARM64, 512 MB, timeout 29 seconds. HTTP API's integration timeout is 30 seconds.

## Service callers in the example

`example/app.ts` sets these when `MCP_AUTH=iam`:

- `TRUSTED_CALLER_ROLES`: the `IAM_CALLER_ROLE_ARN` value, a role ARN
- `USERS`: the `MCP_USERS` JSON, emails lowercased

`TRUSTED_CALLER_ROLES` is comma-separated if you set it yourself. `USERS` is a JSON object of email to scope list, the same map `googleWorkspace` uses.

A SigV4 caller becomes that user when all of these hold:

- `roleArnOf(userArn)` is one of `roleArnOf` on `TRUSTED_CALLER_ROLES`. An assumed-role session `arn:aws:sts::123456789012:assumed-role/Bot/session` and a pathed role `arn:aws:iam::123456789012:role/some/path/Bot` both become `arn:aws:iam::123456789012:role/Bot`. Account and role name identify the role. The path and the session name are dropped. A user ARN does not match. A different account does not match. The partition (`aws`, `aws-cn`, `aws-us-gov`) is kept.
- `mcp-on-behalf-of` is in the signature's signed-header list. The example reads `SignedHeaders` from the `Authorization` header, or `X-Amz-SignedHeaders` on a presigned URL, splits on `;`, and lowercases the names. SigV4 covers the headers the signer listed. Someone who captured the request can replace an unsigned `mcp-on-behalf-of` and the signature still matches. A missing signature, or a `Bearer` authorization header, means the example treats no header as signed.
- The header value, trimmed and lowercased, is a key in `USERS` other than `*`.

The SDK identity is then `{ token: '', clientId: email, scopes, expiresAt: now + 60 }`. Tool checks use those scopes. A trusted bot acting for `alice@example.com` gets Alice's scopes. Failure is the 403 `forbidden_caller` above.

The bot side, with the AI SDK. `createMCPClient`'s HTTP transport takes `fetch` and `headers`, and `aws4fetch` signs the headers, so `mcp-on-behalf-of` is covered:

```ts
import { createMCPClient } from '@ai-sdk/mcp';
import { AwsClient } from 'aws4fetch';

const aws = new AwsClient({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  sessionToken: process.env.AWS_SESSION_TOKEN, // Lambda's role credentials
  service: 'execute-api',
  region: process.env.AWS_REGION,
});

// One client per Slack message: the protocol is stateless, so creating it again is cheap.
const mcp = await createMCPClient({
  transport: {
    type: 'http',
    url: MCP_URL,
    fetch: (url, init) => aws.fetch(url, init),
    headers: { 'mcp-on-behalf-of': slackUserEmail },
  },
});
```

## Tracing in the example

`example/mcp.ts` imports no Autotel or OpenTelemetry package. The construct accepts whatever Lambda you pass, so you can set `tracing: lambda.Tracing.ACTIVE` for X-Ray, or wrap the handler with AWS Lambda Powertools, without using the example's Autotel entry.

`MCP_TRACING` is read at synth by `example/app.ts`:

| `MCP_TRACING`   | Entry                    | Bundle                                                  |
| --------------- | ------------------------ | ------------------------------------------------------- |
| unset or `none` | `example/mcp.ts`         | no Autotel, no OpenTelemetry                            |
| `autotel`       | `example/mcp-autotel.ts` | `autotel`, `autotel-aws`, `autotel-mcp-instrumentation` |

Those packages are devDependencies of this repository. They are not dependencies or peers of the published construct. Setting `OTEL_EXPORTER_OTLP_ENDPOINT` while `MCP_TRACING` is `none` does not switch the entry file.

With `MCP_TRACING=autotel`, the example sets:

- `OTEL_EXPORTER_OTLP_ENDPOINT` from the environment, or `''`
- `OTEL_SERVICE_NAME` from the environment, or `STACK_NAME`

`init()` runs when `OTEL_EXPORTER_OTLP_ENDPOINT` is non-empty. An empty endpoint still deploys the Autotel entry, and exports nothing. The service name inside `init` is `OTEL_SERVICE_NAME` or `aws-cdk-mcp-example`.

`wrapHandler` from `autotel-aws/lambda` flushes one span per invocation. `instrumentMcpServer(server, { networkTransport: 'tcp' })` creates one span per tool call. A caller can put W3C `traceparent`, optional `tracestate`, and optional `baggage` on `params._meta`. The Autotel entry copies those fields onto the Lambda event headers so the invocation span joins the caller's trace, then rewrites `_meta.traceparent` to the invocation span so the tool span is a child of the invocation. Other `_meta` keys are left in place. The caller's `tracestate` and `baggage` stay.

Reparenting is skipped when tracing is off, when `_meta` has no `traceparent`, or when the body is larger than the SDK's `DEFAULT_MAX_REQUEST_BODY_SIZE` (counted in UTF-8 bytes). An oversized body is passed through, and the SDK answers 413.

Changing `MCP_TRACING` changes the asset. Synth and deploy again.

## Production

The default access log group has one month of retention and `RemovalPolicy.DESTROY`. That log is your audit trail (email or client id, and IP, per request), so in production pass a log group you own, and route the 5xx alarm to a place a person will see:

```ts
const server = new StatelessMcpServer(this, 'Mcp', {
  handler,
  auth,
  accessLogs: new logs.LogGroup(this, 'McpAccessLogs', {
    retention: logs.RetentionDays.ONE_YEAR,
    removalPolicy: RemovalPolicy.RETAIN,
    encryptionKey: key, // the key policy must allow logs.<region>.amazonaws.com
  }),
});

server.serverErrorAlarm.addAlarmAction(new SnsAction(opsTopic));
```

Passing `accessLogs` means the construct creates no access-log group of its own. Construct-owned authorizer log groups stay on the one-month destroy policy.

Outside this construct, turn on GuardDuty Lambda Protection, Inspector Lambda scanning, and Security Hub once per account.

## Checks

`pnpm precheck` runs Prettier, oxlint with the vendored [anti-slop](tools/oxlint/anti-slop/UPSTREAM.md) rules, `tsc`, and the tests.

| Script                  | What it runs                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `pnpm build`            | `tsc` into `dist/` (CommonJS, declarations), then the runtime bundles into `lambda/` |
| `pnpm bundle`           | the construct's runtime Lambdas into `lambda/<name>/index.js` with esbuild           |
| `pnpm typecheck`        | `tsc`                                                                                |
| `pnpm test`             | `vitest run`                                                                         |
| `pnpm test:stories`     | the same tests with `STORY_REPORT=1`, writing HTML and Markdown under `reports/`     |
| `pnpm lint`             | `oxlint`                                                                             |
| `pnpm format`           | `prettier --write .`                                                                 |
| `pnpm format:check`     | `prettier --check .`                                                                 |
| `pnpm precheck`         | format check, lint, typecheck, test                                                  |
| `pnpm example:synth`    | bundle, then `cdk synth` of `example/app.ts`, loading `.env` if it exists            |
| `pnpm example:deploy`   | bundle, then `cdk deploy` of that app, `--require-approval never`                    |
| `pnpm example:destroy`  | `cdk destroy` of that app, `--force`                                                 |
| `pnpm changeset`        | record a version bump for the next release                                           |
| `pnpm version-packages` | apply changesets to `package.json` and `CHANGELOG.md`                                |
| `pnpm release`          | build, then `changeset publish`                                                      |

Pull requests to `main` run `.github/workflows/ci.yml`: `pnpm precheck`, `pnpm build`, and `pnpm example:synth` with `MCP_AUTH=none`. A push to `main` runs those checks again, then changesets opens a version pull request or publishes to npm. The one-time npm and GitHub settings are in [`.github/___SETUP.md`](.github/___SETUP.md).

One test synths each auth mode under cdk-nag's AwsSolutions and Serverless packs and fails on any finding. A consumer running those packs inherits nothing from this construct. The acknowledgements in [Auth](#auth) and [Lambdas owned by the construct](#lambdas-owned-by-the-construct) are the exceptions, each with a reason in the construct. Findings on your handler, and on a `lambda` authorizer you supply, are yours.

## Deploy the example

```bash
pnpm install
pnpm precheck
cp .env.example .env
export AWS_PROFILE=…
pnpm example:deploy   # prints the endpoint as the Url output
pnpm example:destroy
```

`example/app.ts` parses the environment with zod. A missing `MCP_AUTH` fails synth. `.env` holds no secrets and no credentials. OAuth client secrets belong to the MCP clients (Claude, Inspector), not this stack.

| Variable                      | When               | Meaning                                                                                            |
| ----------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| `STACK_NAME`                  | optional           | Stack name, default `aws-cdk-mcp-example`. Resource names use this prefix.                         |
| `AWS_REGION`                  | optional           | Stack region. Falls back to `CDK_DEFAULT_REGION`. Account is `CDK_DEFAULT_ACCOUNT`.                |
| `MCP_AUTH`                    | required           | `none`, `google`, `iam`, or `apiKey`.                                                              |
| `MCP_TRACING`                 | optional           | `none` (default) or `autotel`.                                                                     |
| `GOOGLE_CLIENT_IDS`           | `google`           | Comma-separated OAuth client ids. At least one.                                                    |
| `HOSTED_DOMAIN`               | `google`           | Workspace domain, compared to Google's `hd`.                                                       |
| `MCP_USERS`                   | `google` and `iam` | JSON object, email or `*` to scope list. `{"you@example.com":["echo"]}`.                           |
| `IAM_CALLER_ROLE_ARN`         | `iam`              | Role ARN, must start with `arn:`. Granted `execute-api:Invoke`, and set as `TRUSTED_CALLER_ROLES`. |
| `MCP_API_KEYS`                | `apiKey`           | JSON array of `{ sha256, clientId, scopes, expiresAt? }`. The raw key stays out.                   |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `autotel`          | Exporter URL. Empty skips `init()`.                                                                |
| `OTEL_SERVICE_NAME`           | `autotel`          | Span service name. Defaults to `STACK_NAME` on the function.                                       |

`example/app.ts` maps `MCP_AUTH=google` to `auth.type: 'googleWorkspace'`. For `iam` it calls `grantInvoke` on a role imported from `IAM_CALLER_ROLE_ARN`. Pass the bot function when it lives in the same app: `server.grantInvoke(botFn)`.

Handler environment set by the example stack:

| Variable                      | Set when                                           |
| ----------------------------- | -------------------------------------------------- |
| `ALLOW_ANONYMOUS`             | `"true"` for `none`, `"false"` otherwise           |
| `RESOURCE_METADATA_URL`       | `google`, the example mode that publishes metadata |
| `TRUSTED_CALLER_ROLES`        | `iam`                                              |
| `USERS`                       | `iam`                                              |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `MCP_TRACING=autotel`                              |
| `OTEL_SERVICE_NAME`           | `MCP_TRACING=autotel`                              |

`ALLOWED_ORIGINS` is read by the handler and is not set by the example stack. Add it on the function if browsers call the server.

The example does not deploy `jwt` or `lambda`. Those modes are on the construct. Wire them in your own stack with the props in [Auth](#auth).

## Google Cloud

In Google Cloud Console, open Google Auth Platform. Create an Internal app, which limits consent to your Workspace, with scopes `openid` and `email`. Create one OAuth client per kind of MCP client, and pass all of their ids as `clientIds`. The MCP client runs the OAuth flow, so redirect URIs belong on the client.

| OAuth client type | For                                      | Authorized redirect URIs                                                                                                                                              |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web application   | Claude (web, Desktop, mobile), Inspector | `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback`, `http://localhost:6274/oauth/callback`, `http://127.0.0.1:6274/oauth/callback` |
| Desktop app       | Claude Code                              | none. Google allows loopback on any port, which Claude Code's callback port needs.                                                                                    |

Enter redirect URIs with no trailing slash. JavaScript origins are for browser-side flows: `http://localhost:6274` and `http://127.0.0.1:6274` for Inspector, and none for Claude. Inspector builds its callback from whichever of those two hosts your browser opened, and Google treats them as different URIs. Give each MCP client its own client id and secret.

## Limits

API Gateway HTTP APIs set four limits. Each has a workaround.

- **The gateway's own 401 has no `WWW-Authenticate`.** HTTP APIs cannot add headers to it. Clients find the authorization server through the well-known metadata this construct serves, and your handler's own 401s can carry the challenge (the example's do).
- **No WAF, no routing on headers.** The gateway cannot rate-limit on `Mcp-Method` or `Mcp-Name`. Put CloudFront and WAF in front when you need that rule.
- **30-second integration timeout.** For longer work, return a task handle the client polls.
- **The access log cannot record request headers.** Log the protocol version in your handler. The example logs `mcp-protocol-version`, `mcp-method`, and `mcp-name`.

Google adds one more. It mints no token scoped to this resource (RFC 8707) and offers no dynamic client registration, so MCP clients need a pre-registered client id and secret. Claude's custom connectors accept those. For a spec-compliant server, use `jwt` with an authorization server that federates Google.
