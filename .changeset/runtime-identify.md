---
'aws-cdk-mcp': minor
---

Add `aws-cdk-mcp/runtime` with `identify()`, which turns a `jwt` or `lambda` authorizer identity into the MCP SDK's `AuthInfo` and re-checks expiry. Access logs record the caller for `jwt` (`jwtSub`) and `iam` (`iamCaller`). `googleWorkspace` accepts `cacheTtl`. Synth checks for a blank `hostedDomain` and for an authorizer environment over Lambda's 4 KB limit.

The package now has an `exports` map, so import from `aws-cdk-mcp` or `aws-cdk-mcp/runtime` instead of `aws-cdk-mcp/dist/...`.
