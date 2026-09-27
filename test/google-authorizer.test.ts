import { story } from 'executable-stories-vitest';
import { describe, expect, test } from 'vitest';
import {
  authorize,
  decide,
  parseConfig,
  type Fetch,
  type TokenInfo,
  type AuthorizerConfig,
  type UserInfo,
} from '../src/runtime/google-authorizer';

const config: AuthorizerConfig = {
  clientIds: ['web.apps.googleusercontent.com', 'desktop.apps.googleusercontent.com'],
  hostedDomain: 'example.com',
  users: { 'alice@example.com': ['read'], 'bob@example.com': ['read', 'refund'] },
};

const alice: UserInfo = {
  sub: '1001',
  email: 'Alice@example.com',
  email_verified: true,
  hd: 'example.com',
};

const now = 1_800_000_000;

const ours = { aud: 'web.apps.googleusercontent.com', exp: String(now + 600) };

story.feature({
  title: 'Google authorizer',
  narrative: `
    Clients send a Google access token as a bearer token. The Lambda authorizer asks
    Google who it belongs to, then admits only verified Workspace users on the
    allowlist, with the scopes the allowlist gives them. Anything unexpected fails closed.
  `,
  tags: ['auth', 'google'],
});

describe('decide', () => {
  test('an allowlisted Workspace user gets their scopes', ({ task }) => {
    story.init(task);

    story.given('Alice is on the allowlist with "read"');
    story.when('Google vouches for her token from our Web client');
    story.then('she is admitted with her lower-cased email and scopes');
    expect(decide({ tokenInfo: ours, userInfo: alice, now }, config)).toEqual({
      email: 'alice@example.com',
      sub: '1001',
      scopes: 'read',
      exp: now + 600,
    });
  });

  test('an expired token is refused, and one without an expiry too', ({ task }) => {
    story.init(task);

    story.given('a token that has just expired');
    story.then('it is refused');
    expect(
      decide({ tokenInfo: { ...ours, exp: String(now) }, userInfo: alice, now }, config),
    ).toBeUndefined();

    story.given('a token with no expiry');
    story.then('it is refused');
    expect(
      decide(
        { tokenInfo: { aud: 'web.apps.googleusercontent.com' }, userInfo: alice, now },
        config,
      ),
    ).toBeUndefined();
  });

  test("a token from any of our clients is accepted: Claude's Web client or Claude Code's Desktop one", ({
    task,
  }) => {
    story.init(task);

    story.given("a token minted for Claude Code's Desktop client");
    const desktop = { ...ours, aud: 'desktop.apps.googleusercontent.com' };

    story.then('Alice is admitted');
    expect(decide({ tokenInfo: desktop, userInfo: alice, now }, config)?.email).toBe(
      'alice@example.com',
    );
  });

  test('a token minted for another app is refused', ({ task }) => {
    story.init(task);

    story.given('a token whose audience is someone else');
    story.then('it is refused');
    expect(
      decide({ tokenInfo: { ...ours, aud: 'someone-else' }, userInfo: alice, now }, config),
    ).toBeUndefined();
  });

  test('a matching email outside the Workspace (no hd) is refused', ({ task }) => {
    story.init(task);

    story.given('an allowlisted email with no hosted domain claim');
    story.then('it is refused');
    expect(
      decide({ tokenInfo: ours, userInfo: { ...alice, hd: undefined }, now }, config),
    ).toBeUndefined();
  });

  test('an unverified email is refused', ({ task }) => {
    story.init(task);

    story.given('an allowlisted email Google has not verified');
    story.then('it is refused');
    expect(
      decide({ tokenInfo: ours, userInfo: { ...alice, email_verified: false }, now }, config),
    ).toBeUndefined();
  });

  test('a Workspace user who is not on the list is refused', ({ task }) => {
    story.init(task);

    story.given('Carol, a verified Workspace user not on the allowlist');
    const carol = { ...alice, email: 'carol@example.com' };

    story.then('she is refused');
    expect(decide({ tokenInfo: ours, userInfo: carol, now }, config)).toBeUndefined();
  });

  test('users can be keyed by Google sub, so an email rename keeps access', ({ task }) => {
    story.init(task);

    story.given("an allowlist keyed by Alice's sub, not her email");
    const bySub = { ...config, users: { '1001': ['echo'] } };

    story.when('she signs in after her email changed');
    const renamed = { ...alice, email: 'alice.smith@example.com' };

    story.then('she keeps her scopes');
    expect(decide({ tokenInfo: ours, userInfo: renamed, now }, bySub)?.scopes).toBe('echo');
  });
});

describe('authorize', () => {
  // authorize() reads the real clock.
  const live = {
    aud: 'web.apps.googleusercontent.com',
    exp: String(Math.floor(Date.now() / 1000) + 600),
  };

  const googleSays =
    (tokenInfo: TokenInfo, userInfo: UserInfo, ok = true): Fetch =>
    async (url) =>
      Response.json(url.includes('tokeninfo') ? tokenInfo : userInfo, { status: ok ? 200 : 400 });

  test('asks Google about the bearer token and decides on the answer', async ({ task }) => {
    story.init(task);

    story.given('Google recognises the token as Alice');
    story.when('a request arrives with it as a bearer token');

    const identity = await authorize(
      { authorization: 'Bearer ya29.token' },
      { config, fetch: googleSays(live, alice) },
    );

    story.then('Alice is admitted');
    expect(identity?.email).toBe('alice@example.com');
  });

  test('no bearer token, no call to Google', async ({ task }) => {
    story.init(task);

    story.given('a Google that must not be called');

    const fail: Fetch = async () => {
      throw new Error('should not be called');
    };

    story.when('a request has Basic auth, or no authorization at all');
    story.then('it is refused without asking Google');
    expect(
      await authorize({ authorization: 'Basic abc' }, { config, fetch: fail }),
    ).toBeUndefined();
    expect(await authorize({}, { config, fetch: fail })).toBeUndefined();
  });

  test('a socket Google closed while Lambda was frozen is retried, not a refusal', async ({
    task,
  }) => {
    story.init(task);

    story.given("each Google endpoint's first request fails on a stale keep-alive socket");
    const answer = googleSays(live, alice);
    const failed = new Set<string>();

    // Each endpoint's first request dies the way undici reports a stale keep-alive socket.
    const staleOnce: Fetch = async (url, init) => {
      if (!failed.has(url)) {
        failed.add(url);

        throw new TypeError('fetch failed');
      }

      return answer(url, init);
    };

    story.when('Alice presents her token');

    const identity = await authorize(
      { authorization: 'Bearer ya29.token' },
      { config, fetch: staleOnce },
    );

    story.then('the retry succeeds and she is admitted');
    expect(identity?.email).toBe('alice@example.com');
  });

  test('an expired or revoked token (Google 400) is refused', async ({ task }) => {
    story.init(task);

    story.given('Google answers 400 for the token');
    story.when('a request presents it');

    const identity = await authorize(
      { authorization: 'Bearer expired' },
      { config, fetch: googleSays(live, alice, false) },
    );

    story.then('it is refused');
    expect(identity).toBeUndefined();
  });

  test('a response Google would never send is a refusal, not a crash', async ({ task }) => {
    story.init(task);

    story.given('Google answers with malformed fields');
    const odd: Fetch = async () => Response.json({ aud: 42, email_verified: 'yes' });

    story.json({ label: 'Response', value: { aud: 42, email_verified: 'yes' } });
    story.then('the request is refused without throwing');
    expect(await authorize({ authorization: 'Bearer x' }, { config, fetch: odd })).toBeUndefined();
  });
});

describe('parseConfig', () => {
  const env = {
    GOOGLE_CLIENT_IDS: 'web, desktop',
    HOSTED_DOMAIN: 'example.com',
    USERS: JSON.stringify({ 'alice@example.com': ['read'] }),
  };

  test('reads what the construct deploys', ({ task }) => {
    story.init(task);

    story.given('the environment the construct sets on the Lambda');
    story.json({ label: 'Environment', value: env });
    story.then('it parses into client ids, hosted domain and users');
    expect(parseConfig(env)).toEqual({
      clientIds: ['web', 'desktop'],
      hostedDomain: 'example.com',
      users: { 'alice@example.com': ['read'] },
    });
  });

  test('a malformed allowlist fails at cold start instead of letting anyone through', ({
    task,
  }) => {
    story.init(task);

    story.when('USERS maps an email to a string instead of a list');
    story.then('parsing throws');
    expect(() => parseConfig({ ...env, USERS: '{"alice@example.com":"read"}' })).toThrow();

    story.when('GOOGLE_CLIENT_IDS has no real ids');
    story.then('parsing throws');
    expect(() => parseConfig({ ...env, GOOGLE_CLIENT_IDS: ' , ' })).toThrow();
  });
});
