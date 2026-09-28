import { story } from 'executable-stories-vitest';
import { describe, expect, test } from 'vitest';
import { identify } from '../src/runtime/identify';

const now = 1_800_000_000;

story.feature({
  title: 'identify',
  narrative: `
    The handler's half of auth: turn what the gateway's authorizer attached to the request
    into the MCP SDK's AuthInfo, or refuse. Expiry is checked again here because API Gateway
    caches a Lambda authorizer's approval, which can outlive the token.
  `,
  tags: ['auth', 'runtime'],
});

describe('identify', () => {
  test('a Lambda authorizer identity becomes AuthInfo, email preferred over sub', ({ task }) => {
    story.init(task);

    story.given('a Google identity with two scopes');
    story.then('clientId is the email and scopes are split');
    expect(
      identify(
        {
          lambda: { email: 'alice@example.com', sub: '123', scopes: 'read refund', exp: now + 60 },
        },
        now,
      ),
    ).toEqual({
      token: '',
      clientId: 'alice@example.com',
      scopes: ['read', 'refund'],
      expiresAt: now + 60,
    });

    story.and('an API key identity (no email) is known by its sub');
    expect(
      identify({ lambda: { sub: 'team-bot', scopes: '', exp: now + 60 } }, now)?.clientId,
    ).toBe('team-bot');
  });

  test('API Gateway passes Lambda context values as strings; exp is parsed', ({ task }) => {
    story.init(task);

    story.given('exp arrives as a string');
    story.then('it is still honored');
    expect(
      identify({ lambda: { sub: 'x', scopes: 'a', exp: String(now + 60) } }, now)?.expiresAt,
    ).toBe(now + 60);
  });

  test('a JWT identity uses gateway-parsed scopes, else the scope claim', ({ task }) => {
    story.init(task);

    story.given('a JWT with authorizationScopes on the route');
    expect(
      identify({ jwt: { claims: { sub: 'u1', exp: now + 60 }, scopes: ['echo'] } }, now),
    ).toEqual({ token: '', clientId: 'u1', scopes: ['echo'], expiresAt: now + 60 });

    story.and('a JWT without them falls back to the scope claim');
    expect(
      identify({ jwt: { claims: { sub: 'u1', scope: 'a b', exp: now + 60 }, scopes: null } }, now)
        ?.scopes,
    ).toEqual(['a', 'b']);
  });

  test('refuses expired, anonymous, missing and IAM-only callers', ({ task }) => {
    story.init(task);

    story.then('an identity at or past exp is refused, however recently the gateway approved it');
    expect(identify({ lambda: { sub: 'x', scopes: 'a', exp: now } }, now)).toBeUndefined();
    story.and('one without exp is refused');
    expect(identify({ lambda: { sub: 'x', scopes: 'a' } }, now)).toBeUndefined();
    story.and('one without an id is refused');
    expect(identify({ lambda: { scopes: 'a', exp: now + 60 } }, now)).toBeUndefined();
    story.and('no authorizer at all is refused');
    expect(identify(undefined, now)).toBeUndefined();
    story.and('IAM callers are the handler’s own decision: refused here');
    expect(
      identify(
        {
          iam: {
            accessKey: 'AKIA',
            accountId: '123456789012',
            callerId: 'AROA',
            cognitoIdentity: null,
            principalOrgId: null,
            userArn: 'arn:aws:iam::123456789012:role/Bot',
            userId: 'AROA',
          },
        },
        now,
      ),
    ).toBeUndefined();
  });
});
