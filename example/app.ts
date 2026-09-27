// Deploys example/mcp.ts behind StatelessMcpServer. Configured from `.env` (see .env.example);
// the pnpm example:* scripts load it. Credentials come from AWS_PROFILE in your shell.
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { ApiKeysSchema } from '../src/runtime/api-key-authorizer';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { z } from 'zod';
import { StatelessMcpServer, type McpAuth } from '../src';

const csv = z
  .string()
  .transform((raw) =>
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.string()).min(1));

const users = z
  .string()
  .transform((raw) => z.record(z.string(), z.array(z.string())).parse(JSON.parse(raw)));

// MCP_AUTH has no default: a missing variable must not quietly deploy a public endpoint.
const EnvSchema = z.intersection(
  z.object({
    STACK_NAME: z.string().default('aws-cdk-mcp-example'),
    AWS_REGION: z.string().optional(),
    MCP_TRACING: z.enum(['none', 'autotel']).default('none'),
  }),
  z.discriminatedUnion('MCP_AUTH', [
    z.object({ MCP_AUTH: z.literal('none') }),
    z.object({
      MCP_AUTH: z.literal('apiKey'),
      MCP_API_KEYS: z.string().transform((raw) => ApiKeysSchema.parse(JSON.parse(raw))),
    }),
    z.object({
      MCP_AUTH: z.literal('google'),
      GOOGLE_CLIENT_IDS: csv,
      HOSTED_DOMAIN: z.string().min(1),
      MCP_USERS: users,
    }),
    z.object({
      MCP_AUTH: z.literal('iam'),
      IAM_CALLER_ROLE_ARN: z.string().startsWith('arn:'),
      MCP_USERS: users,
    }),
  ]),
);

const env = EnvSchema.parse(process.env);

const app = new cdk.App();

const stack = new cdk.Stack(app, env.STACK_NAME, {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: env.AWS_REGION ?? process.env.CDK_DEFAULT_REGION,
  },
});

const handler = new NodejsFunction(stack, 'McpHandler', {
  entry: path.join(__dirname, env.MCP_TRACING === 'autotel' ? 'mcp-autotel.ts' : 'mcp.ts'),
  runtime: lambda.Runtime.NODEJS_24_X,
  architecture: lambda.Architecture.ARM_64,
  memorySize: 512,
  timeout: cdk.Duration.seconds(29), // HTTP API's integration ceiling is 30s
  // Anonymous callers are a mode, not a fallback: on only when there is no auth at all.
  environment: {
    ALLOW_ANONYMOUS: String(env.MCP_AUTH === 'none'),
  },
});

if (env.MCP_TRACING === 'autotel') {
  handler.addEnvironment(
    'OTEL_EXPORTER_OTLP_ENDPOINT',
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? '',
  );
  handler.addEnvironment('OTEL_SERVICE_NAME', process.env.OTEL_SERVICE_NAME ?? env.STACK_NAME);
}

function authFor(config: typeof env): McpAuth {
  switch (config.MCP_AUTH) {
    case 'none':
      return { type: 'none' };
    case 'apiKey':
      return { type: 'apiKey', keys: config.MCP_API_KEYS };
    case 'google':
      return {
        type: 'googleWorkspace',
        clientIds: config.GOOGLE_CLIENT_IDS,
        hostedDomain: config.HOSTED_DOMAIN,
        users: config.MCP_USERS,
      };
    case 'iam':
      // The bot's role may call, and may say which user it acts for; MCP_USERS says what they may do.
      handler.addEnvironment('TRUSTED_CALLER_ROLES', config.IAM_CALLER_ROLE_ARN);
      handler.addEnvironment('USERS', JSON.stringify(config.MCP_USERS));

      return { type: 'iam' };
  }
}

const server = new StatelessMcpServer(stack, 'Mcp', { handler, auth: authFor(env) });

if (server.resourceMetadataUrl) {
  handler.addEnvironment('RESOURCE_METADATA_URL', server.resourceMetadataUrl);
}

if (env.MCP_AUTH === 'iam') {
  // In the same CDK app, pass the bot's function instead: `server.grantInvoke(botFn)`.
  server.grantInvoke(iam.Role.fromRoleArn(stack, 'Caller', env.IAM_CALLER_ROLE_ARN));
}
