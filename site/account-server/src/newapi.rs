use crate::{
    now,
    store::{ComputeAccount, User},
    App,
};
use serde_json::{json, Value};

const TOKEN_NAME: &str = "somniq-account-service";

pub async fn data(response: reqwest::Response) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err("compute service request failed".into());
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| "invalid compute service response")?;
    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(
            "compute service rejected request; existing users may need account linking".into(),
        );
    }
    Ok(body.get("data").cloned().unwrap_or(Value::Null))
}

pub fn endpoint(app: &App, path: &str) -> String {
    app.config.newapi_url.join(path).unwrap().to_string()
}

pub async fn start(app: &App) -> Result<String, String> {
    let body = data(
        app.client
            .post(endpoint(app, "api/oauth/state"))
            .json(&json!({"provider":"oidc","intent":"login"}))
            .send()
            .await
            .map_err(|_| "compute service unavailable")?,
    )
    .await?;
    body.get("flow_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or("compute login flow missing".into())
}

fn refresh_cookie(response: &reqwest::Response) -> Option<String> {
    response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .filter_map(|v| v.split(';').next())
        .find(|v| v.starts_with("new_api_refresh=") && v.len() > 16)
        .map(str::to_string)
}

async fn bundle(
    response: reqwest::Response,
    previous: Option<&ComputeAccount>,
) -> Result<ComputeAccount, String> {
    let cookie = refresh_cookie(&response)
        .or_else(|| previous.map(|a| a.refresh_cookie.clone()))
        .ok_or("compute refresh credential missing")?;
    let body = data(response).await?;
    let user = &body["user"];
    let user_id = user["id"]
        .as_i64()
        .filter(|id| *id > 0)
        .ok_or("compute user missing")?;
    let oidc_id = user["oidc_id"]
        .as_str()
        .ok_or("compute identity missing")?
        .to_string();
    let access_token = body["access_token"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("compute session missing")?
        .to_string();
    let session_id = body["session"]["sid"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("compute session id missing")?
        .to_string();
    Ok(ComputeAccount {
        user_id,
        oidc_id,
        access_token,
        refresh_cookie: cookie,
        session_id,
        expires_at: body["access_expires_at"].as_i64().unwrap_or(now() + 600),
        model_key: previous.and_then(|v| v.model_key.clone()),
    })
}

pub async fn finish(app: &App, code: &str, state: &str, user: &User) -> Result<(), String> {
    let _lock = app.account_lock(&user.id).await;
    let response = app
        .client
        .get(endpoint(app, "api/oauth/oidc"))
        .query(&[("code", code), ("state", state)])
        .send()
        .await
        .map_err(|_| "compute login unavailable")?;
    let mut account = bundle(response, None).await?;
    if account.oidc_id != user.subject {
        return Err("compute identity does not match signed-in account".into());
    }
    let profile = data(
        app.client
            .get(endpoint(app, "api/user/self"))
            .bearer_auth(&account.access_token)
            .send()
            .await
            .map_err(|_| "compute identity check unavailable")?,
    )
    .await?;
    if profile["id"].as_i64() != Some(account.user_id)
        || profile["oidc_id"].as_str() != Some(user.subject.as_str())
    {
        return Err("compute identity check failed".into());
    }
    // Persist the verified mapping before creating a key: a lost response can
    // be recovered by listing this same user's keys under the per-account lock.
    app.store
        .save_compute(&user.id, &app.config.newapi_instance, &account)?;
    account.model_key = Some(ensure_key(app, &account).await?);
    app.store
        .save_compute(&user.id, &app.config.newapi_instance, &account)
}

async fn find_key_id(app: &App, account: &ComputeAccount) -> Result<Option<i64>, String> {
    let body = data(
        app.client
            .get(endpoint(app, "api/token/search"))
            .bearer_auth(&account.access_token)
            .query(&[("keyword", TOKEN_NAME), ("p", "1"), ("page_size", "100")])
            .send()
            .await
            .map_err(|_| "compute keys unavailable")?,
    )
    .await?;
    let items = body
        .as_array()
        .or_else(|| body.get("items").and_then(Value::as_array))
        .ok_or("invalid compute key list")?;
    Ok(items
        .iter()
        .find(|v| {
            v["name"].as_str() == Some(TOKEN_NAME)
                && v["status"].as_i64() == Some(1)
                && v["expired_time"]
                    .as_i64()
                    .is_some_and(|t| t == -1 || t > now())
        })
        .and_then(|v| v["id"].as_i64()))
}

async fn ensure_key(app: &App, account: &ComputeAccount) -> Result<String, String> {
    let mut id = find_key_id(app, account).await?;
    if id.is_none() {
        data(app.client.post(endpoint(app,"api/token/")).bearer_auth(&account.access_token)
            .json(&json!({"name":TOKEN_NAME,"expired_time":-1,"unlimited_quota":true,"remain_quota":0,"model_limits_enabled":false,"group":""}))
            .send().await.map_err(|_|"compute key creation unavailable")?).await?;
        id = find_key_id(app, account).await?;
    }
    let id = id.ok_or("compute key creation pending; retry connection")?;
    let body = data(
        app.client
            .post(endpoint(app, &format!("api/token/{id}/key")))
            .bearer_auth(&account.access_token)
            .send()
            .await
            .map_err(|_| "compute key unavailable")?,
    )
    .await?;
    let key = body["key"]
        .as_str()
        .filter(|s| {
            (16..=256).contains(&s.len())
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or("compute key missing")?;
    // Current New API returns the raw key here; some compatible deployments
    // include the OpenAI bearer prefix. Normalize only in this adapter.
    Ok(if key.starts_with("sk-") {
        key.to_string()
    } else {
        format!("sk-{key}")
    })
}

pub async fn session(app: &App, user: &User) -> Result<ComputeAccount, String> {
    let _lock = app.account_lock(&user.id).await;
    let mut account = app
        .store
        .compute(&user.id, &app.config.newapi_instance)?
        .ok_or("compute account not connected")?;
    if account.expires_at <= now() + 60 {
        let response = app
            .client
            .post(endpoint(app, "api/user/auth/refresh"))
            .header(reqwest::header::COOKIE, &account.refresh_cookie)
            .header(reqwest::header::ORIGIN, app.config.origin())
            .header("X-Auth-Session", &account.session_id)
            .send()
            .await
            .map_err(|_| "compute renewal unavailable")?;
        let renewed = bundle(response, Some(&account)).await?;
        if renewed.user_id != account.user_id || renewed.oidc_id != user.subject {
            return Err("compute renewal identity mismatch".into());
        }
        account = renewed;
        app.store
            .save_compute(&user.id, &app.config.newapi_instance, &account)?;
    }
    if account.model_key.is_none() {
        account.model_key = Some(ensure_key(app, &account).await?);
        app.store
            .save_compute(&user.id, &app.config.newapi_instance, &account)?;
    }
    Ok(account)
}
