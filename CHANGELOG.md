# aws-cdk-mcp

## 0.4.0

### Minor Changes

- b9e4df0: `googleWorkspace` auth: a `*` key in `users` admits everyone in `hostedDomain`. A named entry wins over it.

## 0.3.0

### Minor Changes

- 4458814: Add `publicUrl` and `metadataApi` for OAuth discovery on custom domains, including API mapping prefixes. Expose `stage` for attaching API mappings.

## 0.2.0

### Minor Changes

- 5ada6d1: Add `aws-cdk-mcp/runtime` with `identify()`, which turns a `jwt` or `lambda` authorizer identity into the MCP SDK's `AuthInfo` and re-checks expiry. Access logs record the caller for `jwt` (`jwtSub`) and `iam` (`iamCaller`). `googleWorkspace` accepts `cacheTtl`. Synth checks for a blank `hostedDomain` and for an authorizer environment over Lambda's 4 KB limit.

  The package now has an `exports` map, so import from `aws-cdk-mcp` or `aws-cdk-mcp/runtime` instead of `aws-cdk-mcp/dist/...`.

## 0.1.0

### Minor Changes

- 93b2036: First release of `StatelessMcpServer`: a CDK construct for a stateless (2026-07-28) MCP server on an HTTP API and Lambda, with `none`, `apiKey`, `iam`, `jwt`, `lambda`, and `googleWorkspace` auth, RFC 9728 metadata, access logs, and a 5xx alarm. Node.js 24 or later.
