use crate::{store::Flow, App};
use openidconnect::{
    core::{CoreAuthenticationFlow, CoreClient, CoreProviderMetadata},
    AccessTokenHash, AuthorizationCode, ClientId, ClientSecret, CsrfToken, IssuerUrl, Nonce,
    OAuth2TokenResponse, PkceCodeChallenge, PkceCodeVerifier, RedirectUrl, Scope,
};

pub async fn metadata(app: &App) -> Result<CoreProviderMetadata, String> {
    CoreProviderMetadata::discover_async(
        IssuerUrl::new(app.config.issuer.to_string()).map_err(|_| "invalid issuer")?,
        &app.client,
    )
    .await
    .map_err(|_| "identity service unavailable".into())
}

pub async fn start(app: &App) -> Result<(String, String, Flow), String> {
    let metadata = metadata(app).await?;
    let client = CoreClient::from_provider_metadata(
        metadata,
        ClientId::new(app.config.client_id.clone()),
        Some(ClientSecret::new(app.config.client_secret.clone())),
    )
    .set_redirect_uri(
        RedirectUrl::new(
            app.config
                .public_url
                .join("v2/account/callback")
                .unwrap()
                .to_string(),
        )
        .unwrap(),
    );
    let (challenge, verifier) = PkceCodeChallenge::new_random_sha256();
    let (url, state, nonce) = client
        .authorize_url(
            CoreAuthenticationFlow::AuthorizationCode,
            CsrfToken::new_random,
            Nonce::new_random,
        )
        .add_scope(Scope::new("email".into()))
        .add_scope(Scope::new("profile".into()))
        .set_pkce_challenge(challenge)
        .url();
    Ok((
        url.to_string(),
        state.secret().to_string(),
        Flow {
            kind: "oidc".into(),
            verifier: verifier.secret().to_string(),
            nonce: nonce.secret().to_string(),
            session_hash: None,
        },
    ))
}

pub async fn finish(
    app: &App,
    code: String,
    flow: Flow,
) -> Result<(String, String, String), String> {
    let metadata = metadata(app).await?;
    let client = CoreClient::from_provider_metadata(
        metadata,
        ClientId::new(app.config.client_id.clone()),
        Some(ClientSecret::new(app.config.client_secret.clone())),
    )
    .set_redirect_uri(
        RedirectUrl::new(
            app.config
                .public_url
                .join("v2/account/callback")
                .unwrap()
                .to_string(),
        )
        .unwrap(),
    );
    let token = client
        .exchange_code(AuthorizationCode::new(code))
        .map_err(|_| "identity token endpoint missing")?
        .set_pkce_verifier(PkceCodeVerifier::new(flow.verifier))
        .request_async(&app.client)
        .await
        .map_err(|_| "identity authorization failed")?;
    let id_token = token
        .extra_fields()
        .id_token()
        .ok_or("identity token missing")?;
    let verifier = client.id_token_verifier();
    let nonce = Nonce::new(flow.nonce);
    let claims = id_token
        .claims(&verifier, &nonce)
        .map_err(|_| "identity token validation failed")?;
    if let Some(expected) = claims.access_token_hash() {
        let actual = AccessTokenHash::from_token(
            token.access_token(),
            id_token
                .signing_alg()
                .map_err(|_| "invalid signing algorithm")?,
            id_token
                .signing_key(&verifier)
                .map_err(|_| "invalid signing key")?,
        )
        .map_err(|_| "invalid access token")?;
        if &actual != expected {
            return Err("identity access token validation failed".into());
        }
    }
    let subject = claims.subject().as_str().to_string();
    let email = claims
        .email()
        .map(|v| v.as_str())
        .filter(|v| !v.is_empty())
        .ok_or("verified email required")?
        .to_string();
    if claims.email_verified() != Some(true) {
        return Err("verified email required".into());
    }
    let name = claims
        .preferred_username()
        .map(|v| v.as_str())
        .unwrap_or(&email)
        .to_string();
    Ok((subject, email, name))
}
