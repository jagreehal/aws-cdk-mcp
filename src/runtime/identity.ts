/** Identity supplied by Lambda authorizers. `sub` identifies a user or API key client. */
export interface McpIdentity {
  readonly sub: string;
  readonly email?: string;
  /** Space-separated tool scopes. */
  readonly scopes: string;
  /** Expiry in epoch seconds; handlers should check it even when verdicts are cached. */
  readonly exp: number;
}
