// RFC 9728 protected-resource metadata: tells an MCP client which authorization server to sign in at.
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' },
    body: JSON.stringify({
      // From the request, so it stays right behind a custom domain.
      resource: `https://${event.requestContext.domainName}${process.env.MCP_PATH}`,
      authorization_servers: [process.env.AUTHORIZATION_SERVER],
      scopes_supported: process.env.SCOPES?.split(' '),
      bearer_methods_supported: ['header'],
    }),
  };
}
