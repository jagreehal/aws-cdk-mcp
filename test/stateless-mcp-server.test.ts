import { story } from 'executable-stories-vitest';
import { describe, expect, test } from 'vitest';
import { App, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { StatelessMcpServer, type StatelessMcpServerProps } from '../src';

const google: StatelessMcpServerProps['auth'] = {
  type: 'googleWorkspace',
  clientIds: ['client-123.apps.googleusercontent.com', 'desktop-456.apps.googleusercontent.com'],
  hostedDomain: 'example.com',
  users: { 'Alice@example.com': ['read'], 'bob@example.com': ['read', 'refund'] },
};

type Auth = StatelessMcpServerProps['auth'];

const fn = (stack: Stack, id: string) =>
  new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'),
  });

/** Synth one server whose auth needs the stack, e.g. to create a bring-your-own authorizer. */
function synthWith(makeAuth: (stack: Stack) => Auth): Template {
  const stack = new Stack(new App(), 'Test');

  new StatelessMcpServer(stack, 'Mcp', { handler: fn(stack, 'Handler'), auth: makeAuth(stack) });

  return Template.fromStack(stack);
}

/** Synth one server; only `auth` differs between tests. */
const synth = (auth: Auth) => synthWith(() => auth);

story.feature({
  title: 'StatelessMcpServer construct',
  narrative: `
    A stateless MCP server is one HTTP API in front of one Lambda: no sessions, no
    load balancer, no cache, no table. The \`auth\` prop picks who may call \`/mcp\`:
    nobody checked, API keys, a JWT issuer, IAM roles, your own authorizer, or
    Google Workspace users.
  `,
  tags: ['cdk', 'construct'],
});

describe('StatelessMcpServer', () => {
  test('has no session machinery: one API, one stage, no load balancer, no cache, no table', ({
    task,
  }) => {
    story.init(task);

    story.given('a server with auth "none"');
    const template = synth({ type: 'none' });

    story.then('the stack has one HTTP API and no load balancer, cache or table');
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 0);
    template.resourceCountIs('AWS::ElastiCache::ServerlessCache', 0);
    template.resourceCountIs('AWS::DynamoDB::Table', 0);
  });

  test('names the API after the stack, so a prefixed stack gives a prefixed API', ({ task }) => {
    story.init(task);

    story.given('a server in stack "Test" with id "Mcp"');
    story.then('the API is named "Test-Mcp"');
    synth({ type: 'none' }).hasResourceProperties('AWS::ApiGatewayV2::Api', { Name: 'Test-Mcp' });
  });

  test('routes POST, GET and DELETE /mcp to the handler, throttled and access-logged', ({
    task,
  }) => {
    story.init(task);

    story.given('a server with auth "none"');
    const template = synth({ type: 'none' });

    story.then('POST, GET and DELETE /mcp are routed without authorization');

    for (const method of ['POST', 'GET', 'DELETE']) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: `${method} /mcp`,
        AuthorizationType: 'NONE',
      });
    }

    story.and('the default stage is throttled at 50 rps (burst 100) and access-logged');
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      DefaultRouteSettings: { ThrottlingRateLimit: 50, ThrottlingBurstLimit: 100 },
      AccessLogSettings: Match.objectLike({ DestinationArn: Match.anyValue() }),
    });
  });

  test('access logs name the caller whichever authorizer ran', ({ task }) => {
    story.init(task);

    story.given('a server with auth "none"');
    story.then('the log format records Lambda, JWT and IAM caller fields');
    synth({ type: 'none' }).hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: {
        Format: Match.serializedJson(
          Match.objectLike({
            email: '$context.authorizer.email',
            clientId: '$context.authorizer.sub',
            jwtSub: '$context.authorizer.claims.sub',
            iamCaller: '$context.identity.userArn',
          }),
        ),
        DestinationArn: Match.anyValue(),
      },
    });
  });

  test('access logs can go to a log group the consumer owns, retained and longer-lived', ({
    task,
  }) => {
    story.init(task);

    story.given('a log group kept for a year and retained when the stack is deleted');
    const stack = new Stack(new App(), 'Test');

    const accessLogs = new logs.LogGroup(stack, 'Audit', {
      retention: logs.RetentionDays.ONE_YEAR,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    story.when('the server is given it as accessLogs');
    new StatelessMcpServer(stack, 'Mcp', {
      handler: fn(stack, 'Handler'),
      auth: { type: 'none' },
      accessLogs,
    });

    const template = Template.fromStack(stack);

    story.then('the stage logs there and the construct creates no access log group of its own');
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AccessLogSettings: {
        DestinationArn: stack.resolve(accessLogs.logGroupArn),
        Format: Match.anyValue(),
      },
    });
    template.resourceCountIs('AWS::Logs::LogGroup', 1);
  });

  test('alarms on gateway 5xx, with no action until the consumer adds one', ({ task }) => {
    story.init(task);

    story.given('a server with auth "none"');
    const template = synth({ type: 'none' });

    story.then('an alarm fires on 5 or more 5xx responses in 5 minutes');
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: '5xx',
      Namespace: 'AWS/ApiGateway',
      Statistic: 'Sum',
      Period: 300,
      Threshold: 5,
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      TreatMissingData: 'notBreaching',
    });

    story.and('it has no alarm actions');
    const [alarm] = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
    expect(alarm.Properties.AlarmActions).toBeUndefined();
  });

  test('exposes the metadata URL only when it publishes metadata', ({ task }) => {
    story.init(task);

    const urlFor = (auth: Auth) => {
      const stack = new Stack(new App(), 'Test');

      return new StatelessMcpServer(stack, 'Mcp', { handler: fn(stack, 'Handler'), auth })
        .resourceMetadataUrl;
    };

    story.given('a server with auth "none"');
    story.then('resourceMetadataUrl is undefined');
    expect(urlFor({ type: 'none' })).toBeUndefined();

    story.given('a server with Google Workspace auth');
    story.then('resourceMetadataUrl points at /.well-known/oauth-protected-resource/mcp');
    expect(urlFor(google)).toMatch(/\/\.well-known\/oauth-protected-resource\/mcp$/);
  });

  test("auth 'none' publishes no protected-resource metadata", ({ task }) => {
    story.init(task);

    story.given('a server with auth "none"');
    const routes = synth({ type: 'none' }).findResources('AWS::ApiGatewayV2::Route');

    story.then('no route serves oauth-protected-resource metadata');
    expect(JSON.stringify(routes)).not.toContain('oauth-protected-resource');
  });

  test('publishes mapped-resource discovery on the domain root API, without its default auth', ({
    task,
  }) => {
    story.init(task);

    story.given('an MCP endpoint at /docs/mcp and a root API with default JWT auth');
    const stack = new Stack(new App(), 'Mapped');

    const metadataApi = new apigwv2.HttpApi(stack, 'RootApi', {
      defaultAuthorizer: new HttpJwtAuthorizer('RootAuth', 'https://auth.example.com', {
        jwtAudience: ['root'],
      }),
      defaultAuthorizationScopes: ['root:read'],
    });

    const server = new StatelessMcpServer(stack, 'Mcp', {
      handler: fn(stack, 'Handler'),
      auth: google,
      publicUrl: 'https://docs.example.com/docs/mcp',
      metadataApi,
    });

    const domain = new apigwv2.DomainName(stack, 'DocsDomain', {
      domainName: 'docs.example.com',
      certificate: acm.Certificate.fromCertificateArn(
        stack,
        'Certificate',
        'arn:aws:acm:eu-west-1:123456789012:certificate/test',
      ),
    });

    new apigwv2.ApiMapping(stack, 'RootMapping', { api: metadataApi, domainName: domain });
    new apigwv2.ApiMapping(stack, 'DocsMapping', {
      api: server.api,
      stage: server.stage,
      domainName: domain,
      apiMappingKey: 'docs',
    });
    const template = Template.fromStack(stack);

    story.then('the endpoint and metadata URLs use the full public path');
    expect(server.url).toBe('https://docs.example.com/docs/mcp');
    expect(server.resourceMetadataUrl).toBe(
      'https://docs.example.com/.well-known/oauth-protected-resource/docs/mcp',
    );

    story.and('the domain maps discovery at the root and the MCP stage under docs');
    template.hasResourceProperties('AWS::ApiGatewayV2::ApiMapping', {
      ApiId: stack.resolve(metadataApi.apiId),
      ApiMappingKey: Match.absent(),
      Stage: '$default',
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::ApiMapping', {
      ApiId: stack.resolve(server.api.apiId),
      ApiMappingKey: 'docs',
      Stage: '$default',
    });

    story.and('both discovery routes are public on the root API');

    for (const path of ['/docs/mcp', '']) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        ApiId: stack.resolve(metadataApi.apiId),
        RouteKey: `GET /.well-known/oauth-protected-resource${path}`,
        AuthorizationType: 'NONE',
        AuthorizerId: Match.absent(),
        AuthorizationScopes: Match.absent(),
      });
    }

    story.and('MCP calls still use the authenticated route on the MCP API');
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      ApiId: stack.resolve(server.api.apiId),
      RouteKey: 'POST /mcp',
      AuthorizationType: 'CUSTOM',
    });

    story.and('metadata advertises the public resource instead of the gateway path');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ PUBLIC_RESOURCE_URL: server.url }),
      },
    });
  });

  test('uses a root-mapped public domain without requiring a separate metadata API', ({ task }) => {
    story.init(task);

    story.given('a public URL whose path is the MCP route');
    const stack = new Stack(new App(), 'Domain');

    const server = new StatelessMcpServer(stack, 'Mcp', {
      handler: fn(stack, 'Handler'),
      auth: google,
      publicUrl: 'https://docs.example.com/mcp',
    });

    story.then('metadata stays on the MCP API and advertises the public domain');
    expect(server.resourceMetadataUrl).toBe(
      'https://docs.example.com/.well-known/oauth-protected-resource/mcp',
    );
    Template.fromStack(stack).hasResourceProperties('AWS::ApiGatewayV2::Route', {
      ApiId: stack.resolve(server.api.apiId),
      RouteKey: 'GET /.well-known/oauth-protected-resource/mcp',
      AuthorizationType: 'NONE',
    });
  });

  test('rejects an OAuth mapping prefix without a root metadata API', ({ task }) => {
    story.init(task);

    story.given('an OAuth endpoint under /docs, with no root API for discovery');
    const stack = new Stack(new App(), 'MissingDiscovery');

    story.then('construction fails instead of deploying unreachable discovery');
    expect(
      () =>
        new StatelessMcpServer(stack, 'Mcp', {
          handler: fn(stack, 'Handler'),
          auth: google,
          publicUrl: 'https://docs.example.com/docs/mcp',
        }),
    ).toThrow(/metadataApi mapped at the domain root/);
  });

  test('rejects public resource URLs carrying credentials, queries or fragments', ({ task }) => {
    story.init(task);

    story.given('a URL that cannot be an HTTPS OAuth resource identifier');

    for (const publicUrl of [
      'http://docs.example.com/mcp',
      'https://user:secret@docs.example.com/mcp',
      'https://docs.example.com/mcp?token=secret',
      'https://docs.example.com/mcp#section',
    ]) {
      const stack = new Stack(new App(), 'InvalidUrl');

      story.then('construction refuses the URL without repeating its secrets');
      expect(
        () =>
          new StatelessMcpServer(stack, 'Mcp', {
            handler: fn(stack, 'Handler'),
            auth: google,
            publicUrl,
          }),
      ).toThrow(/publicUrl must be an HTTPS URL/);
    }
  });

  test('rejects a public URL without an MCP path or with a trailing slash', ({ task }) => {
    story.init(task);

    for (const publicUrl of ['https://docs.example.com', 'https://docs.example.com/mcp/']) {
      story.given(`publicUrl ${publicUrl}`);
      const stack = new Stack(new App(), 'TrailingSlash');

      story.then('construction names the path as the problem');
      expect(
        () =>
          new StatelessMcpServer(stack, 'Mcp', {
            handler: fn(stack, 'Handler'),
            auth: google,
            publicUrl,
          }),
      ).toThrow(/without a trailing slash/);
    }
  });

  test('rejects metadataApi when the auth mode publishes no discovery metadata', ({ task }) => {
    story.init(task);

    story.given('IAM auth with a root metadata API');
    const stack = new Stack(new App(), 'IamMetadata');

    story.then('construction fails instead of ignoring the API');
    expect(
      () =>
        new StatelessMcpServer(stack, 'Mcp', {
          handler: fn(stack, 'Handler'),
          auth: { type: 'iam' },
          publicUrl: 'https://docs.example.com/docs/mcp',
          metadataApi: new apigwv2.HttpApi(stack, 'RootApi'),
        }),
    ).toThrow(/metadataApi needs an OAuth auth mode/);
  });

  test('apiKey protects every route using x-api-key, with no cache or OAuth metadata', ({
    task,
  }) => {
    story.init(task);

    story.given('a server with one API key for "team-bot"');

    const template = synth({
      type: 'apiKey',
      keys: [{ sha256: 'a'.repeat(64), clientId: 'team-bot', scopes: ['echo'] }],
    });

    story.then('a REQUEST authorizer reads x-api-key with caching off');
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      EnableSimpleResponses: true,
      IdentitySource: ['$request.header.x-api-key'],
      AuthorizerResultTtlInSeconds: 0,
    });

    story.and('every /mcp route uses it');

    for (const method of ['POST', 'GET', 'DELETE']) {
      template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
        RouteKey: `${method} /mcp`,
        AuthorizationType: 'CUSTOM',
      });
    }

    story.but('no OAuth metadata is published');
    expect(JSON.stringify(template.findResources('AWS::ApiGatewayV2::Route'))).not.toContain(
      'oauth-protected-resource',
    );

    story.and('the authorizer receives the key hashes in API_KEYS');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: {
          API_KEYS: JSON.stringify([
            { sha256: 'a'.repeat(64), clientId: 'team-bot', scopes: ['echo'] },
          ]),
        },
      },
    });
  });

  test('apiKey rejects missing or invalid hashes at synth', ({ task }) => {
    story.init(task);

    story.when('apiKey auth is given no keys');
    story.then('synth fails');
    expect(() => synth({ type: 'apiKey', keys: [] })).toThrow();

    story.when('apiKey auth is given a raw key instead of a sha256 hash');
    story.then('synth fails');
    expect(() =>
      synth({ type: 'apiKey', keys: [{ sha256: 'raw-key', clientId: 'bot', scopes: [] }] }),
    ).toThrow();
  });

  test('jwt: API Gateway validates issuer and audience', ({ task }) => {
    story.init(task);

    story.given('jwt auth with an issuer, audience "mcp" and required scope "mcp:tools"');

    const template = synth({
      type: 'jwt',
      issuer: 'https://idp.example.com',
      audience: ['mcp'],
      requiredScopes: ['mcp:tools'],
    });

    story.then('a JWT authorizer checks the issuer and audience');
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      JwtConfiguration: { Issuer: 'https://idp.example.com', Audience: ['mcp'] },
    });

    story.and('POST /mcp requires the "mcp:tools" scope');
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'POST /mcp',
      AuthorizationType: 'JWT',
      // What keeps ID tokens (no scope claim) and under-scoped tokens out.
      AuthorizationScopes: ['mcp:tools'],
    });
  });

  test('jwt refuses an empty requiredScopes rather than accepting ID tokens', ({ task }) => {
    story.init(task);

    story.when('jwt auth is given an empty requiredScopes');
    story.then('synth fails naming requiredScopes');
    expect(() =>
      synth({ type: 'jwt', issuer: 'https://idp', audience: ['mcp'], requiredScopes: [] }),
    ).toThrow(/requiredScopes/);
  });

  describe('iam (service callers)', () => {
    /** A server with IAM auth and a bot role granted to call it. */
    function synthIam(grant: boolean): Template {
      const stack = new Stack(new App(), 'Test');

      const server = new StatelessMcpServer(stack, 'Mcp', {
        handler: fn(stack, 'Handler'),
        auth: { type: 'iam' },
      });

      if (grant) {
        server.grantInvoke(
          new iam.Role(stack, 'BotRole', {
            assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
          }),
        );
      }

      return Template.fromStack(stack);
    }

    test('signs every /mcp route with AWS_IAM, and publishes no OAuth metadata', ({ task }) => {
      story.init(task);

      story.given('a server with IAM auth');
      const template = synthIam(false);

      story.then('every /mcp route requires AWS_IAM');

      for (const method of ['POST', 'GET', 'DELETE']) {
        template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
          RouteKey: `${method} /mcp`,
          AuthorizationType: 'AWS_IAM',
        });
      }

      story.but('no OAuth metadata is published');
      expect(JSON.stringify(template.findResources('AWS::ApiGatewayV2::Route'))).not.toContain(
        'oauth-protected-resource',
      );
    });

    test('grantInvoke gives the role execute-api:Invoke on the /mcp routes', ({ task }) => {
      story.init(task);

      story.given('a server with IAM auth');
      story.when('grantInvoke is called with a bot role');
      story.then('the role gets execute-api:Invoke on POST /mcp');
      synthIam(true).hasResourceProperties('AWS::IAM::Policy', {
        Roles: [{ Ref: Match.stringLikeRegexp('BotRole') }],
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'execute-api:Invoke',
              Resource: Match.objectLike({
                'Fn::Join': Match.arrayWith([Match.arrayWith(['/*/POST/mcp'])]),
              }),
            }),
          ]),
        },
      });
    });

    test('grantInvoke refuses a server whose callers are people, not roles', ({ task }) => {
      story.init(task);

      story.given('a server with Google Workspace auth');
      const stack = new Stack(new App(), 'Test');

      const server = new StatelessMcpServer(stack, 'Mcp', {
        handler: fn(stack, 'Handler'),
        auth: google,
      });

      const role = new iam.Role(stack, 'BotRole', {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });

      story.when('grantInvoke is called with a role');
      story.then('it throws');
      expect(() => server.grantInvoke(role)).toThrow();
    });
  });

  describe('lambda (bring your own)', () => {
    test('puts your authorizer in front of every /mcp route, with your cache TTL', ({ task }) => {
      story.init(task);

      story.given('your own authorizer Lambda with a 30 second cache TTL');

      const template = synthWith((stack) => ({
        type: 'lambda',
        authorizer: fn(stack, 'MyAuthorizer'),
        cacheTtl: Duration.seconds(30),
      }));

      story.then('a REQUEST authorizer caches results for 30 seconds');
      template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        AuthorizerType: 'REQUEST',
        EnableSimpleResponses: true,
        AuthorizerResultTtlInSeconds: 30,
      });

      story.and('every /mcp route uses it');

      for (const method of ['POST', 'GET', 'DELETE']) {
        template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
          RouteKey: `${method} /mcp`,
          AuthorizationType: 'CUSTOM',
        });
      }
    });

    test('publishes protected-resource metadata only when told where clients sign in', ({
      task,
    }) => {
      story.init(task);

      story.given('one server without an authorizationServer and one with it');
      const without = synthWith((stack) => ({ type: 'lambda', authorizer: fn(stack, 'A') }));

      const withServer = synthWith((stack) => ({
        type: 'lambda',
        authorizer: fn(stack, 'A'),
        authorizationServer: 'https://auth.example.com',
      }));

      story.then('the first publishes no metadata');
      expect(JSON.stringify(without.findResources('AWS::ApiGatewayV2::Route'))).not.toContain(
        'oauth-protected-resource',
      );

      story.and('the second points clients at its authorization server');
      withServer.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({ AUTHORIZATION_SERVER: 'https://auth.example.com' }),
        },
      });
    });
  });

  describe('googleWorkspace', () => {
    test('puts a cached Lambda authorizer in front of every /mcp route', ({ task }) => {
      story.init(task);

      story.given('a server with Google Workspace auth');
      const template = synth(google);

      story.then('a REQUEST authorizer reads Authorization and caches for 5 minutes');
      template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
        AuthorizerType: 'REQUEST',
        EnableSimpleResponses: true,
        IdentitySource: ['$request.header.Authorization'],
        AuthorizerResultTtlInSeconds: 300,
      });

      story.and('every /mcp route uses it');

      for (const method of ['POST', 'GET', 'DELETE']) {
        template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
          RouteKey: `${method} /mcp`,
          AuthorizationType: 'CUSTOM',
        });
      }
    });

    test('hands the authorizer the client id, domain and lower-cased users', ({ task }) => {
      story.init(task);

      story.given('Google auth with two client ids, domain example.com and a mixed-case user');
      story.json({ label: 'auth', value: google });
      story.then('the authorizer environment carries them, with emails lower-cased');
      synth(google).hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: {
            GOOGLE_CLIENT_IDS:
              'client-123.apps.googleusercontent.com,desktop-456.apps.googleusercontent.com',
            HOSTED_DOMAIN: 'example.com',
            USERS: JSON.stringify({
              'alice@example.com': ['read'],
              'bob@example.com': ['read', 'refund'],
            }),
          },
        },
      });
    });

    test('serves unauthenticated protected-resource metadata pointing at Google', ({ task }) => {
      story.init(task);

      story.given('a server with Google Workspace auth');
      const template = synth(google);

      story.then('both well-known metadata routes are open without authorization');

      for (const route of [
        'GET /.well-known/oauth-protected-resource',
        'GET /.well-known/oauth-protected-resource/mcp',
      ]) {
        template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
          RouteKey: route,
          AuthorizationType: 'NONE',
        });
      }

      story.and('the metadata names accounts.google.com as the authorization server');
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({ AUTHORIZATION_SERVER: 'https://accounts.google.com' }),
        },
      });
    });

    test('refuses an empty clientIds, which would refuse every token', ({ task }) => {
      story.init(task);

      story.when('Google auth is given no client ids');
      story.then('synth fails naming clientIds');
      expect(() => synth({ ...google, clientIds: [] })).toThrow(/clientIds/);
    });

    test('refuses an empty hostedDomain, which would fail every cold start', ({ task }) => {
      story.init(task);

      story.when('Google auth is given an empty hostedDomain');
      story.then('synth fails naming hostedDomain');
      expect(() => synth({ ...google, hostedDomain: '' })).toThrow(/hostedDomain/);
    });

    test('refuses a users map too big for the Lambda environment', ({ task }) => {
      story.init(task);

      story.given('200 users, well past the 4 KB Lambda environment limit');

      const users = Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`user${i}@example.com`, ['read']]),
      );

      story.then('synth fails, rather than the deploy');
      expect(() => synth({ ...google, users })).toThrow(/environment budget/);
    });

    test('counts the whole authorizer environment against the 4 KB limit, not just users', ({
      task,
    }) => {
      story.init(task);

      story.given('110 users and 12 client ids: users fit alone, the environment does not');

      const users = Object.fromEntries(
        Array.from({ length: 110 }, (_, i) => [`user${i}@example.com`, ['read']]),
      );

      const clientIds = Array.from(
        { length: 12 },
        (_, i) => `${i}-abcdefghijklmnopqrstuvwxyz0123456789.apps.googleusercontent.com`,
      );

      expect(Buffer.byteLength(JSON.stringify(users))).toBeLessThan(3500);
      expect(
        Buffer.byteLength(
          JSON.stringify({
            GOOGLE_CLIENT_IDS: clientIds.join(','),
            HOSTED_DOMAIN: 'example.com',
            USERS: JSON.stringify(users),
          }),
        ),
      ).toBeGreaterThan(4096);

      story.then('synth fails');
      expect(() => synth({ ...google, clientIds, users })).toThrow(/environment budget/);
    });

    test('caches verdicts for cacheTtl when given, so removals bite sooner', ({ task }) => {
      story.init(task);

      story.given('Google auth with cacheTtl of 30 seconds');
      story.then('the authorizer caches for 30 seconds');
      synth({ ...google, cacheTtl: Duration.seconds(30) }).hasResourceProperties(
        'AWS::ApiGatewayV2::Authorizer',
        { AuthorizerResultTtlInSeconds: 30 },
      );
    });

    test('refuses an empty allowlist rather than letting the whole domain in', ({ task }) => {
      story.init(task);

      story.when('Google auth is given no users');
      story.then('synth fails asking for at least one');
      expect(() => synth({ ...google, users: {} })).toThrow(/at least one/);
    });
  });

  test('deploys prebuilt runtime handlers, so consumers need no esbuild or Docker', ({ task }) => {
    story.init(task);

    story.when('a Google-auth server is synthesized');
    const template = synth(google);

    story.then('its authorizer is a plain Lambda running the bundled index.handler');
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 'index.handler',
      Runtime: 'nodejs24.x',
      Environment: { Variables: Match.objectLike({ HOSTED_DOMAIN: Match.anyValue() }) },
    });
  });
});
