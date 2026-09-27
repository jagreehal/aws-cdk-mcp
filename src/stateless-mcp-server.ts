import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { AccessLogFormat } from 'aws-cdk-lib/aws-apigateway';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import {
  HttpIamAuthorizer,
  HttpJwtAuthorizer,
  HttpLambdaAuthorizer,
  HttpLambdaResponseType,
} from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { ApiKeysSchema, type ApiKey } from './runtime/api-key-authorizer';

/**
 * Who may call the server. There is no default: an internet-facing MCP endpoint with no auth
 * should be something you wrote down, not something you forgot.
 */
export type McpAuth =
  /** Public. For throwaway environments only. */
  | { readonly type: 'none' }
  /**
   * AWS IAM (SigV4), for services rather than people: a Slack bot's Lambda role, a worker.
   * Grant callers with `server.grantInvoke(role)`. The handler gets
   * `event.requestContext.authorizer.iam` (`userArn`, `accountId`…). Note that any principal in
   * the account whose own policy allows `execute-api:Invoke` here also gets through, so a handler
   * that acts on behalf of users should trust only the caller roles it knows.
   */
  | { readonly type: 'iam' }
  /**
   * Machine clients sending `x-api-key`. Store only SHA-256 hashes of high-entropy keys.
   * The built-in Lambda authorizer grants each client its configured scopes; no OAuth metadata.
   * Key removal/rotation requires a redeploy. Verdict caching is disabled.
   */
  | { readonly type: 'apiKey'; readonly keys: ApiKey[] }
  /**
   * Any OAuth server that mints JWT access tokens for this server (Cognito federating Google,
   * Okta, Entra, better-auth's OIDC provider…), validated by API Gateway before the Lambda runs.
   * Claims reach the handler at `event.requestContext.authorizer.jwt.claims`.
   *
   * The audience contract: `audience` must identify this MCP server and nothing else (Cognito
   * checks `client_id` instead of `aud`), so a token minted for another resource is refused.
   */
  | {
      readonly type: 'jwt';
      readonly issuer: string;
      readonly audience: string[];
      /**
       * The token must carry at least one of these in its `scope`/`scp` claim. Required: it is
       * also what keeps ID tokens out, since they carry no scope.
       */
      readonly requiredScopes: string[];
      /** Advertised in the protected-resource metadata. @default requiredScopes */
      readonly scopes?: string[];
    }
  /**
   * Bring your own: any Lambda authorizer (better-auth, an introspection endpoint, API keys…).
   * It must return the HTTP API simple response, `{ isAuthorized, context }`, with `context`
   * an {@link McpIdentity}: that is what the handler reads and the access log records.
   */
  | {
      readonly type: 'lambda';
      readonly authorizer: lambda.IFunction;
      /** Where clients sign in, advertised in the protected-resource metadata. Omit to serve none. */
      readonly authorizationServer?: string;
      /** @default ['openid'] */
      readonly scopes?: string[];
      /** How long API Gateway caches a verdict per token. @default 5 minutes */
      readonly cacheTtl?: cdk.Duration;
      /** @default ['$request.header.Authorization'] */
      readonly identitySource?: string[];
    }
  /**
   * Google Workspace sign-in, no Cognito: the built-in `lambda` authorizer. Google authenticates; `users` is the authorization.
   * The handler gets `event.requestContext.authorizer.lambda` = `{ email, sub, scopes }`,
   * `scopes` space-separated.
   */
  | {
      readonly type: 'googleWorkspace';
      /**
       * OAuth client ids of your Internal Google OAuth app(s); tokens minted for any other client
       * are refused. Usually more than one: a Web client for Claude (exact redirect URIs) and a
       * Desktop client for Claude Code (loopback on any port).
       */
      readonly clientIds: string[];
      /** Workspace domain, checked against Google's `hd` claim, e.g. `example.com`. */
      readonly hostedDomain: string;
      /**
       * email or Google `sub` → scopes. A caller matching neither is refused, even inside the
       * domain. Prefer `sub` for people whose email may change: Google keeps it stable.
       */
      readonly users: Record<string, string[]>;
    };

export interface StatelessMcpServerProps {
  /** Your MCP server. Answer JSON (`responseMode: 'json'`): API Gateway does not stream. */
  readonly handler: lambda.IFunction;
  readonly auth: McpAuth;
  /** @default '/mcp' */
  readonly path?: string;
  /** Stage-wide throttle. @default 50 rps, burst 100 */
  readonly throttle?: apigwv2.ThrottleSettings;
  /**
   * Where the access log goes. It records who called what (email, client id, IP), so production
   * usually wants its own: longer retention, `RemovalPolicy.RETAIN`, a KMS key.
   * @default a log group with one month's retention, deleted with the stack
   */
  readonly accessLogs?: logs.ILogGroup;
}

type LambdaAuth = Extract<McpAuth, { type: 'lambda' }>;

/**
 * A remote MCP server on the 2026-07-28 protocol: HTTP API → Lambda, nothing else.
 *
 * What is deliberately absent is the point. The protocol has no sessions, so there is no
 * stickiness, no session table and no Redis: any invocation can answer any request.
 * Application state (a cart id, a task id) is yours, in your own datastore, keyed by an id the
 * tool hands back.
 */
export class StatelessMcpServer extends Construct {
  public readonly api: apigwv2.HttpApi;
  /** The MCP endpoint, e.g. `https://abc.execute-api.eu-west-1.amazonaws.com/mcp`. */
  public readonly url: string;
  /**
   * The RFC 9728 metadata URL, when this server publishes one. Hand it to your handler so its own
   * 401s can carry `WWW-Authenticate: Bearer …, resource_metadata="…"`.
   */
  public readonly resourceMetadataUrl?: string;

  /**
   * Fires on 5xx from the gateway: handler errors, timeouts, throttled or failing authorizers.
   * It has no action; add yours with `server.serverErrorAlarm.addAlarmAction(...)`.
   */
  public readonly serverErrorAlarm: cloudwatch.Alarm;

  private readonly mcpRoutes: apigwv2.HttpRoute[];

  constructor(scope: Construct, id: string, props: StatelessMcpServerProps) {
    super(scope, id);

    const {
      handler,
      auth,
      path: mcpPath = '/mcp',
      throttle = { rateLimit: 50, burstLimit: 100 },
      accessLogs = new logs.LogGroup(this, 'AccessLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    } = props;

    this.api = new apigwv2.HttpApi(this, 'Api', {
      // Named after the stack, like every other resource here, so a `jag-` stack gives a
      // `jag-` API. CDK's default is the bare construct id, `Api`.
      apiName: `${cdk.Stack.of(this).stackName}-${id}`,
      description: 'Stateless MCP server (protocol 2026-07-28)',
      createDefaultStage: false,
    });

    // Not 'Default': CDK drops that id from logical ids, so it would collide with the Api's.
    const stage = this.api.addStage('Stage', {
      stageName: '$default',
      autoDeploy: true,
      throttle,
      accessLogSettings: {
        destination: new apigwv2.LogGroupLogDestination(accessLogs),
        // Who called what. `authorizer.email` is set by lambda/googleWorkspace authorizers.
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: '$context.requestId',
            ip: '$context.identity.sourceIp',
            route: '$context.routeKey',
            status: '$context.status',
            latencyMs: '$context.responseLatency',
            email: '$context.authorizer.email',
            clientId: '$context.authorizer.sub',
            authError: '$context.authorizer.error',
          }),
        ),
      },
    });

    this.url = `${stage.url.replace(/\/$/, '')}${mcpPath}`;

    const resolved =
      auth.type === 'googleWorkspace'
        ? this.googleAuth(auth)
        : auth.type === 'apiKey'
          ? this.apiKeyAuth(auth)
          : auth;

    // POST is the 2026-07-28 protocol. GET/DELETE are the 2025 session operations: routed so the
    // SDK's legacy fallback can answer them 405 as that spec requires, rather than a gateway 404.
    this.mcpRoutes = this.api.addRoutes({
      path: mcpPath,
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration: new HttpLambdaIntegration('Mcp', handler),
      authorizer: createAuthorizer(resolved),
      authorizationScopes: resolved.type === 'jwt' ? resolved.requiredScopes : undefined,
    });

    if (resolved.type === 'none') {
      for (const route of this.mcpRoutes) {
        acknowledgePublic(
          route,
          "auth: { type: 'none' } was chosen explicitly; there is no default.",
        );
      }
    }

    const issuer =
      resolved.type === 'jwt'
        ? resolved.issuer
        : resolved.type === 'lambda'
          ? resolved.authorizationServer
          : undefined;

    // OAuth modes only: IAM callers sign requests, there is nothing to discover.
    if (issuer && (resolved.type === 'jwt' || resolved.type === 'lambda')) {
      const scopes =
        resolved.scopes ?? (resolved.type === 'jwt' ? resolved.requiredScopes : ['openid']);

      this.addProtectedResourceMetadata(mcpPath, issuer, scopes);
      this.resourceMetadataUrl = `${stage.url.replace(/\/$/, '')}/.well-known/oauth-protected-resource${mcpPath}`;
    }

    this.serverErrorAlarm = this.api
      .metricServerError({ period: cdk.Duration.minutes(5), statistic: 'Sum' })
      .createAlarm(this, 'ServerErrors', {
        alarmDescription: `${this.url} returned 5xx`,
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });

    new cdk.CfnOutput(this, 'Url', { value: this.url, description: 'MCP endpoint' });
  }

  /**
   * Let a role (e.g. a Slack bot's Lambda) call the MCP endpoint with SigV4. Only for
   * `auth: { type: 'iam' }`: other modes do not use IAM grants.
   */
  public grantInvoke(grantee: iam.IGrantable): void {
    // HttpRoute.grantInvoke throws unless the route has an IAM authorizer: the guard we want.
    for (const route of this.mcpRoutes) route.grantInvoke(grantee);
  }

  private apiKeyAuth(auth: Extract<McpAuth, { type: 'apiKey' }>): LambdaAuth {
    const keys = ApiKeysSchema.parse(auth.keys);
    const serialized = JSON.stringify(keys);

    if (Buffer.byteLength(serialized, 'utf8') > 3500) {
      throw new Error(
        'apiKey configuration exceeds the Lambda environment budget; use a custom Lambda authorizer backed by a secret store.',
      );
    }

    const authorizer = this.runtimeFunction('ApiKeyAuthorizer', 'api-key-authorizer', {
      API_KEYS: serialized,
    });

    return {
      type: 'lambda',
      authorizer,
      identitySource: ['$request.header.x-api-key'],
      cacheTtl: cdk.Duration.seconds(0),
    };
  }

  /** Google is a preset: our authorizer Lambda, fed the allowlist, handed to the `lambda` path. */
  private googleAuth(auth: Extract<McpAuth, { type: 'googleWorkspace' }>): LambdaAuth {
    const users = Object.fromEntries(
      Object.entries(auth.users).map(([user, scopes]) => [user.toLowerCase(), scopes]),
    );

    if (Object.keys(users).length === 0) {
      throw new Error('googleWorkspace auth needs at least one entry in `users`.');
    }

    if (auth.clientIds.length === 0) {
      throw new Error('googleWorkspace auth needs at least one of `clientIds`.');
    }

    const authorizer = this.runtimeFunction('GoogleAuthorizer', 'google-authorizer', {
      GOOGLE_CLIENT_IDS: auth.clientIds.join(','),
      HOSTED_DOMAIN: auth.hostedDomain,
      // ponytail: Lambda env caps at 4 KB (~80 users); move to SSM/AppConfig past that.
      USERS: JSON.stringify(users),
    });

    return {
      type: 'lambda',
      authorizer,
      authorizationServer: 'https://accounts.google.com',
      scopes: ['openid', 'email'],
    };
  }

  /**
   * RFC 9728 metadata, so a client that gets a 401 can find the authorization server. HTTP APIs
   * cannot add `WWW-Authenticate` to their own 401, so clients take the spec's fallback: the
   * well-known URL, path-suffixed first, then the root.
   */
  private addProtectedResourceMetadata(mcpPath: string, issuer: string, scopes: string[]): void {
    const fn = this.runtimeFunction('ProtectedResourceMetadata', 'protected-resource', {
      MCP_PATH: mcpPath,
      AUTHORIZATION_SERVER: issuer,
      SCOPES: scopes.join(' '),
    });

    const integration = new HttpLambdaIntegration('ProtectedResourceMetadata', fn);

    for (const path of [
      `/.well-known/oauth-protected-resource${mcpPath}`,
      '/.well-known/oauth-protected-resource',
    ]) {
      for (const route of this.api.addRoutes({
        path,
        methods: [apigwv2.HttpMethod.GET],
        integration,
      })) {
        acknowledgePublic(route, 'RFC 9728: clients read this before they have a token.');
      }
    }
  }

  /**
   * One of this construct's own Lambdas, with its own log group (retention set, unlike Lambda's
   * default) and a role that can write only there, not AWSLambdaBasicExecutionRole's `logs:*` on `*`.
   */
  private runtimeFunction(
    id: string,
    runtime: string,
    environment: Record<string, string>,
  ): lambda.Function {
    const logGroup = new logs.LogGroup(this, `${id}Logs`, {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const role = new iam.Role(this, `${id}Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    });

    logGroup.grantWrite(role);

    const fn = new lambda.Function(this, id, {
      // Bundled by tools/bundle-lambdas.mts during the build and shipped in the package.
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', runtime)),
      handler: 'index.handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      environment,
      role,
      logGroup,
    });

    cdk.Validations.of(fn).acknowledge(
      {
        id: 'Serverless::Serverless-LambdaDLQ',
        reason:
          'API Gateway invokes it synchronously; a DLQ only receives failed async invocations.',
      },
      {
        id: 'Serverless::Serverless-LambdaTracing',
        reason:
          'Internal authorizers and metadata handlers use CloudWatch logs; application tracing is configured on the consumer-owned handler.',
      },
    );

    return fn;
  }
}

/** A route that is public on purpose, said once here so every consumer's cdk-nag run agrees. */
function acknowledgePublic(route: apigwv2.HttpRoute, reason: string): void {
  cdk.Validations.of(route).acknowledge({ id: 'AwsSolutions::AwsSolutions-APIG4', reason });
}

function createAuthorizer(
  auth: Exclude<McpAuth, { type: 'googleWorkspace' | 'apiKey' }>,
): apigwv2.IHttpRouteAuthorizer | undefined {
  switch (auth.type) {
    case 'none':
      return undefined;
    case 'iam':
      return new HttpIamAuthorizer();
    case 'jwt':
      if (auth.requiredScopes.length === 0) {
        throw new Error('jwt auth needs at least one of `requiredScopes`.');
      }

      return new HttpJwtAuthorizer('Jwt', auth.issuer, { jwtAudience: auth.audience });
    case 'lambda':
      return new HttpLambdaAuthorizer('Lambda', auth.authorizer, {
        responseTypes: [HttpLambdaResponseType.SIMPLE],
        identitySource: auth.identitySource ?? ['$request.header.Authorization'],
        // A removed user keeps access until their cached verdict expires.
        resultsCacheTtl: auth.cacheTtl ?? cdk.Duration.minutes(5),
      });
  }
}
