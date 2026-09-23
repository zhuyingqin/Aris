// Only for isolated development/test realms. Production configuration is separate.
export function developmentRealm(config, origins = ['http://127.0.0.1:8800', 'http://127.0.0.1:5180']) {
  return {
    realm: 'somniq', displayName: 'SomniQ Studio', enabled: true,
    registrationAllowed: true, resetPasswordAllowed: true, verifyEmail: true, loginWithEmailAllowed: true,
    bruteForceProtected: true,
    clients: [
      { clientId: 'somniq-web', name: 'SomniQ Studio', enabled: true, protocol: 'openid-connect', publicClient: false, secret: config.oidcSecret,
        standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: origins.map(origin => `${origin}/v2/account/callback`),
        attributes: { 'pkce.code.challenge.method': 'S256' }, defaultClientScopes: ['profile', 'email'] },
      { clientId: 'newapi', name: 'SomniQ Compute', enabled: true, protocol: 'openid-connect', publicClient: false, secret: config.newapiSecret,
        standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: origins.map(origin => `${origin}/oauth/oidc`), defaultClientScopes: ['profile', 'email'] },
    ],
    users: [{ username: 'alice', enabled: true, email: 'alice@example.invalid', emailVerified: true, firstName: 'Alice', lastName: 'Local',
      credentials: [{ type: 'password', value: config.testPassword, temporary: false }] }],
  };
}
