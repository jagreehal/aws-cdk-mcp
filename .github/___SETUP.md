# GitHub Actions and npm publishing

CI runs on pull requests to `main`. A push to `main` runs the same checks, then changesets opens a version PR or publishes to npm.

## Workflows

- **CI** (`.github/workflows/ci.yml`): `pnpm precheck`, `pnpm build`, and `pnpm example:synth` with `MCP_AUTH=none`. Patch and minor Dependabot PRs are set to auto-merge after those checks pass.
- **Release** (`.github/workflows/release.yml`): on `main`, calls CI, then `changesets/action` with `pnpm release`. npm auth is OIDC (`id-token: write`, `NPM_CONFIG_PROVENANCE=true`). No `NPM_TOKEN` secret.
- **Pages** (`.github/workflows/pages.yml`): on `main`, runs `pnpm test:stories` and publishes `reports/` to GitHub Pages.
- **Changeset** (`.github/workflows/changeset.yml`): a pull request must contain a changeset, except the version PR branch `changeset-release/main`.

Publishing runs only when `github.repository_owner` is `jagreehal`, in the `release` environment.

## One-time setup

1. On npm, add this repository as a trusted publisher for `aws-cdk-mcp`:
   - Repository: `jagreehal/aws-cdk-mcp`
   - Workflow: `.github/workflows/release.yml`
   - Settings: https://www.npmjs.com/settings/jagreehal/tokens
2. In the GitHub repo, allow auto-merge, and allow GitHub Actions to create pull requests (the version PR).
3. Optional: a ruleset on `main` with "Require review from Code Owners". `CODEOWNERS` names `@jaggitadmin`, who needs write access on this repo or GitHub ignores the rule.
4. The release job uses a GitHub environment named `release`. Create it if you want required reviewers before publish. GitHub creates the environment on first use when the job is allowed to.

5. Settings → Pages → Source: **GitHub Actions**, so `pages.yml` can deploy.

## First release

```bash
pnpm changeset
```

Choose `aws-cdk-mcp`, the bump, and a summary. Commit the file under `.changeset/`, open a pull request, and merge it to `main`. Release then opens "chore: release packages". Merging that PR publishes.

`pnpm version-packages` and `pnpm release` do the same two steps on your machine. `pnpm release` needs an npm login. The workflow does not.
