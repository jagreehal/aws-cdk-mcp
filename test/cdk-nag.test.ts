// cdk-nag over every auth mode: a consumer running AwsSolutions or Serverless checks inherits no
// findings from this construct. What is deliberate is acknowledged inside it, with the reason.
import { story } from 'executable-stories-vitest';
import { describe, expect, test } from 'vitest';
import { App, Duration, Stack, Validations } from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { AwsSolutionsChecks, ServerlessChecks } from 'cdk-nag';
import { StatelessMcpServer, type McpAuth } from '../src';

const modes: Record<McpAuth['type'], (stack: Stack) => McpAuth> = {
  none: () => ({ type: 'none' }),
  iam: () => ({ type: 'iam' }),
  apiKey: () => ({
    type: 'apiKey',
    keys: [{ sha256: 'a'.repeat(64), clientId: 'bot', scopes: ['echo'] }],
  }),
  jwt: () => ({
    type: 'jwt',
    issuer: 'https://idp.example.com',
    audience: ['mcp'],
    requiredScopes: ['mcp:tools'],
  }),
  lambda: (stack) => ({
    type: 'lambda',
    authorizer: consumerFunction(stack, 'MyAuthorizer'),
    authorizationServer: 'https://auth.example.com',
  }),
  googleWorkspace: () => ({
    type: 'googleWorkspace',
    clientIds: ['client.apps.googleusercontent.com'],
    hostedDomain: 'example.com',
    users: { 'alice@example.com': ['read'] },
  }),
};

/** Stands in for the consumer's own function: its findings are theirs, so they are acknowledged here. */
function consumerFunction(stack: Stack, id: string): lambda.Function {
  const fn = new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    memorySize: 256,
    timeout: Duration.seconds(5),
  });

  const reason = 'test fixture standing in for the consumer';

  Validations.of(fn).acknowledge(
    {
      // IAM findings carry the policy in their id.
      id: 'AwsSolutions::AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]',
      reason,
    },
    { id: 'Serverless::Serverless-LambdaDLQ', reason },
    { id: 'Serverless::Serverless-LambdaTracing', reason },
  );

  return fn;
}

story.feature({
  title: 'cdk-nag',
  narrative: `
    A consumer running AwsSolutions or Serverless checks inherits no findings from
    this construct, in any auth mode. What is deliberate is acknowledged inside the
    construct, with the reason.
  `,
  tags: ['cdk-nag', 'compliance'],
});

describe('cdk-nag', () => {
  for (const [mode, makeAuth] of Object.entries(modes)) {
    test(`auth '${mode}' synthesizes clean under AwsSolutions and Serverless checks`, ({
      task,
    }) => {
      story.init(task);

      story.given(`a StatelessMcpServer with auth '${mode}'`);
      const app = new App();
      const stack = new Stack(app, 'Test');

      new StatelessMcpServer(stack, 'Mcp', {
        handler: consumerFunction(stack, 'Handler'),
        auth: makeAuth(stack),
      });

      story.when('AwsSolutions and Serverless checks are added');
      Validations.of(app).addPlugins(new AwsSolutionsChecks(app), new ServerlessChecks(app));

      story.then('synth raises no findings');
      // Synth throws ValidationFailed with the full report when any rule fires.
      expect(() => app.synth()).not.toThrow();
    });
  }
});
