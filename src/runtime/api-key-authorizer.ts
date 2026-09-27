import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from 'aws-lambda';
import { z } from 'zod';

/** Hashes only: raw keys must never appear in templates or Lambda environment variables. */
export const ApiKeysSchema = z
  .array(
    z.object({
      sha256: z
        .string()
        .regex(/^[a-fA-F0-9]{64}$/)
        .toLowerCase(),
      clientId: z.string().trim().min(1),
      scopes: z.array(z.string().regex(/^\S+$/)),
      expiresAt: z.number().int().positive().optional(),
    }),
  )
  .min(1)
  .refine((keys) => new Set(keys.map((key) => key.sha256)).size === keys.length, {
    message: 'API key hashes must be unique',
  });

export type ApiKey = z.infer<typeof ApiKeysSchema>[number];

export type ApiKeyIdentity = { sub: string; scopes: string; exp: number };

/** Match the credential, then grant only the configured client and scopes. */
export function authorize(
  key: string | undefined,
  keys: ApiKey[],
  now: number,
): ApiKeyIdentity | undefined {
  // Require high-entropy credentials (generate at least 32 random bytes); no whitespace or lists.
  if (!key || !/^\S{32,}$/.test(key) || key.includes(',')) return undefined;

  const digest = createHash('sha256').update(key).digest();
  const match = keys.find((entry) => timingSafeEqual(digest, Buffer.from(entry.sha256, 'hex')));

  if (!match || (match.expiresAt !== undefined && match.expiresAt <= now)) return undefined;

  // Verdicts are not cached. A short identity lifetime lets the handler enforce its exp contract.
  return {
    sub: match.clientId,
    scopes: match.scopes.join(' '),
    exp: Math.min(match.expiresAt ?? now + 60, now + 60),
  };
}

export async function handler(
  event: APIGatewayRequestAuthorizerEventV2,
): Promise<APIGatewaySimpleAuthorizerWithContextResult<ApiKeyIdentity | undefined>> {
  try {
    const keys = ApiKeysSchema.parse(JSON.parse(process.env.API_KEYS ?? '[]'));
    const identity = authorize(event.headers?.['x-api-key'], keys, Math.floor(Date.now() / 1000));

    return { isAuthorized: identity !== undefined, context: identity };
  } catch {
    // Never log credentials or malformed deployment configuration.
    console.error('[api-key-authorizer] invalid configuration');

    return { isAuthorized: false, context: undefined };
  }
}
