//! Thunderbird-style mail account autoconfiguration.
//!
//! Discovery order follows the mature desktop-client pattern:
//!   1. ISP-hosted Thunderbird autoconfig endpoint.
//!   2. Thunderbird ISPDB.
//!   3. Known-provider presets for common consumer mailboxes.
//!   4. Conservative `imap.<domain>` / `smtp.<domain>` fallback.

use std::time::Duration;

use super::model::{MailAutoconfigResult, MailSocketSecurity};

const USER_AGENT: &str = "SomniQ Mail Autoconfig/0.3";

pub fn discover(email: &str) -> Result<MailAutoconfigResult, String> {
    let email = normalize_email(email)?;
    let (local, domain) = email
        .split_once('@')
        .ok_or_else(|| runtime::ui_lang::tr_static("邮箱地址格式无效", "Invalid email address format", "El formato de la dirección de correo no es válido").to_string())?;

    if let Some(result) = discover_from_thunderbird(&email, local, domain) {
        return Ok(result);
    }
    if let Some(result) = provider_preset(&email, domain) {
        return Ok(result);
    }
    Ok(guess_from_domain(&email, domain))
}

fn normalize_email(email: &str) -> Result<String, String> {
    let email = email.trim().to_ascii_lowercase();
    if email.is_empty() {
        return Err(runtime::ui_lang::tr_static("请先输入邮箱地址", "Enter an email address first", "Primero escribe una dirección de correo").to_string());
    }
    let Some((local, domain)) = email.split_once('@') else {
        return Err(runtime::ui_lang::tr_static("邮箱地址必须包含 @", "The email address must contain @", "La dirección de correo debe contener @").to_string());
    };
    if local.trim().is_empty() || domain.trim().is_empty() || !domain.contains('.') {
        return Err(runtime::ui_lang::tr_static("邮箱地址格式无效", "Invalid email address format", "El formato de la dirección de correo no es válido").to_string());
    }
    Ok(email)
}

fn discover_from_thunderbird(
    email: &str,
    local: &str,
    domain: &str,
) -> Option<MailAutoconfigResult> {
    let encoded = urlencoding::encode(email);
    let candidates = [
        (
            format!("https://autoconfig.{domain}/mail/config-v1.1.xml?emailaddress={encoded}"),
            runtime::ui_lang::tr_static("域名 Autoconfig", "Domain Autoconfig", "Autoconfig del dominio"),
        ),
        (
            format!("https://{domain}/.well-known/autoconfig/mail/config-v1.1.xml?emailaddress={encoded}"),
            runtime::ui_lang::tr_static("域名 .well-known Autoconfig", "Domain .well-known Autoconfig", "Autoconfig .well-known del dominio"),
        ),
        (
            format!("https://autoconfig.thunderbird.net/v1.1/{domain}"),
            "Thunderbird ISPDB",
        ),
    ];
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent(USER_AGENT)
        .build()
        .ok()?;
    for (url, source) in candidates {
        let Ok(response) = client.get(url).send() else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(body) = response.text() else {
            continue;
        };
        if let Some(result) = parse_thunderbird_xml(&body, email, local, domain, source) {
            return Some(result);
        }
    }
    None
}

fn parse_thunderbird_xml(
    xml: &str,
    email: &str,
    local: &str,
    domain: &str,
    source: &str,
) -> Option<MailAutoconfigResult> {
    let incoming = server_block(xml, "incomingServer", "imap")?;
    let outgoing = server_block(xml, "outgoingServer", "smtp");
    let display_name = tag_value(xml, "displayName").unwrap_or_else(|| domain.to_string());

    let imap_host = tag_value(&incoming, "hostname")?;
    let imap_port = tag_value(&incoming, "port")?.parse::<u16>().ok()?;
    let imap_security = socket_security(tag_value(&incoming, "socketType").as_deref());
    let imap_username = username_from_config(
        tag_value(&incoming, "username").as_deref(),
        email,
        local,
        domain,
    );

    let mut notes = Vec::new();
    if block_mentions_oauth(&incoming)
        || outgoing
            .as_ref()
            .is_some_and(|block| block_mentions_oauth(block))
    {
        notes.push(runtime::ui_lang::tr_static("该服务商的 Thunderbird 配置提到了 OAuth2；普通账户密码通常不可用，请优先使用服务商 OAuth/API，或使用明确支持的授权码/应用专用密码。", "This provider's Thunderbird configuration mentions OAuth2, so the normal account password usually does not work. Prefer the provider's OAuth/API, or an authorization code or app-specific password it explicitly supports.", "La configuración de Thunderbird de este proveedor menciona OAuth2, así que la contraseña normal de la cuenta no suele funcionar. Usa preferentemente el OAuth/API del proveedor, o un código de autorización o contraseña de aplicación que admita expresamente.").to_string());
    }

    let (smtp_enabled, smtp_host, smtp_port, smtp_security, smtp_username) =
        if let Some(outgoing) = outgoing {
            (
                true,
                tag_value(&outgoing, "hostname").unwrap_or_default(),
                tag_value(&outgoing, "port")
                    .and_then(|value| value.parse::<u16>().ok())
                    .unwrap_or(465),
                socket_security(tag_value(&outgoing, "socketType").as_deref()),
                username_from_config(
                    tag_value(&outgoing, "username").as_deref(),
                    email,
                    local,
                    domain,
                ),
            )
        } else {
            (
                false,
                String::new(),
                465,
                MailSocketSecurity::Tls,
                imap_username.clone(),
            )
        };

    Some(MailAutoconfigResult {
        source: source.to_string(),
        display_name,
        imap_host,
        imap_port,
        imap_security,
        imap_username,
        smtp_enabled,
        smtp_host,
        smtp_port,
        smtp_security,
        smtp_username,
        notes,
    })
}

fn server_block(xml: &str, tag: &str, server_type: &str) -> Option<String> {
    let mut offset = 0;
    let start_marker = format!("<{tag}");
    let end_marker = format!("</{tag}>");
    while let Some(relative_start) = xml[offset..].find(&start_marker) {
        let start = offset + relative_start;
        let header_end = xml[start..].find('>')? + start;
        let header = &xml[start..=header_end];
        let end = xml[header_end + 1..].find(&end_marker)? + header_end + 1;
        let block = &xml[start..end + end_marker.len()];
        let type_attr = format!("type=\"{server_type}\"");
        let type_attr_single = format!("type='{server_type}'");
        if header.contains(&type_attr) || header.contains(&type_attr_single) {
            return Some(block.to_string());
        }
        offset = end + end_marker.len();
    }
    None
}

fn tag_value(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml_unescape(xml[start..end].trim()))
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn socket_security(value: Option<&str>) -> MailSocketSecurity {
    match value.unwrap_or("").trim().to_ascii_uppercase().as_str() {
        "SSL" | "TLS" => MailSocketSecurity::Tls,
        "STARTTLS" => MailSocketSecurity::Starttls,
        "PLAIN" | "NONE" => MailSocketSecurity::None,
        _ => MailSocketSecurity::Tls,
    }
}

fn username_from_config(value: Option<&str>, email: &str, local: &str, domain: &str) -> String {
    let value = value.unwrap_or("%EMAILADDRESS%").trim();
    if value.is_empty() {
        return email.to_string();
    }
    value
        .replace("%EMAILADDRESS%", email)
        .replace("%EMAILLOCALPART%", local)
        .replace("%EMAILDOMAIN%", domain)
}

fn block_mentions_oauth(block: &str) -> bool {
    block.to_ascii_lowercase().contains("oauth")
}

fn provider_preset(email: &str, domain: &str) -> Option<MailAutoconfigResult> {
    let preset = match domain {
        "gmail.com" | "googlemail.com" => (
            "Gmail",
            "imap.gmail.com",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp.gmail.com",
            465,
            MailSocketSecurity::Tls,
            vec![runtime::ui_lang::tr_static("Gmail 的普通 Google 密码不能用于 IMAP LOGIN；请优先使用 Gmail OAuth/API，或在启用 IMAP 后使用 Google 应用专用密码。", "A regular Google password cannot be used for Gmail IMAP LOGIN. Prefer Gmail OAuth/API, or enable IMAP and use a Google app password.", "La contraseña normal de Google no sirve para IMAP LOGIN en Gmail. Usa preferentemente Gmail OAuth/API, o activa IMAP y usa una contraseña de aplicación de Google.")],
        ),
        "outlook.com" | "hotmail.com" | "live.com" | "msn.com" => (
            "Outlook.com",
            "outlook.office365.com",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp-mail.outlook.com",
            587,
            MailSocketSecurity::Starttls,
            vec![runtime::ui_lang::tr_static("Outlook.com / Microsoft 365 要求 Modern Authentication/OAuth2；此通用 IMAP/SMTP 密码路径不适用，请使用 Outlook OAuth/Graph。", "Outlook.com / Microsoft 365 require Modern Authentication/OAuth2, so this generic IMAP/SMTP password route does not apply. Use Outlook OAuth/Graph.", "Outlook.com / Microsoft 365 exigen Modern Authentication/OAuth2, así que esta vía genérica de IMAP/SMTP con contraseña no sirve. Usa Outlook OAuth/Graph.")],
        ),
        "qq.com" | "foxmail.com" => (
            "QQ Mail",
            "imap.qq.com",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp.qq.com",
            465,
            MailSocketSecurity::Tls,
            vec![runtime::ui_lang::tr_static("QQ 邮箱需要在网页端开启 IMAP/SMTP，并使用授权码作为密码。", "QQ Mail needs IMAP/SMTP turned on in its web interface, with an authorization code as the password.", "QQ Mail necesita activar IMAP/SMTP en su web y usar un código de autorización como contraseña.")],
        ),
        "163.com" => (
            "NetEase 163",
            "imap.163.com",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp.163.com",
            465,
            MailSocketSecurity::Tls,
            vec![runtime::ui_lang::tr_static("网易邮箱通常需要开启客户端授权，并使用授权码。", "NetEase Mail usually needs client authorization turned on and an authorization code.", "El correo de NetEase suele necesitar activar la autorización de clientes y usar un código de autorización.")],
        ),
        "126.com" => (
            "NetEase 126",
            "imap.126.com",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp.126.com",
            465,
            MailSocketSecurity::Tls,
            vec![runtime::ui_lang::tr_static("网易邮箱通常需要开启客户端授权，并使用授权码。", "NetEase Mail usually needs client authorization turned on and an authorization code.", "El correo de NetEase suele necesitar activar la autorización de clientes y usar un código de autorización.")],
        ),
        "yeah.net" => (
            "NetEase Yeah",
            "imap.yeah.net",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp.yeah.net",
            465,
            MailSocketSecurity::Tls,
            vec![runtime::ui_lang::tr_static("网易邮箱通常需要开启客户端授权，并使用授权码。", "NetEase Mail usually needs client authorization turned on and an authorization code.", "El correo de NetEase suele necesitar activar la autorización de clientes y usar un código de autorización.")],
        ),
        "icloud.com" | "me.com" | "mac.com" => (
            "iCloud Mail",
            "imap.mail.me.com",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp.mail.me.com",
            587,
            MailSocketSecurity::Starttls,
            vec![runtime::ui_lang::tr_static("iCloud 邮箱需要 Apple 应用专用密码。", "iCloud Mail needs an Apple app-specific password.", "iCloud Mail necesita una contraseña específica de app de Apple.")],
        ),
        "yahoo.com" | "ymail.com" | "rocketmail.com" => (
            "Yahoo Mail",
            "imap.mail.yahoo.com",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp.mail.yahoo.com",
            465,
            MailSocketSecurity::Tls,
            vec![runtime::ui_lang::tr_static("Yahoo 邮箱通常需要应用专用密码。", "Yahoo Mail usually needs an app password.", "Yahoo Mail suele necesitar una contraseña de aplicación.")],
        ),
        "fastmail.com" => (
            "Fastmail",
            "imap.fastmail.com",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp.fastmail.com",
            465,
            MailSocketSecurity::Tls,
            vec![runtime::ui_lang::tr_static("Fastmail 推荐使用应用专用密码。", "Fastmail recommends an app password.", "Fastmail recomienda usar una contraseña de aplicación.")],
        ),
        "zoho.com" => (
            "Zoho Mail",
            "imap.zoho.com",
            993,
            MailSocketSecurity::Tls,
            true,
            "smtp.zoho.com",
            465,
            MailSocketSecurity::Tls,
            vec![runtime::ui_lang::tr_static("Zoho 若开启两步验证，需要使用应用专用密码。", "With two-step verification on, Zoho needs an app-specific password.", "Si tienes activada la verificación en dos pasos, Zoho necesita una contraseña de aplicación.")],
        ),
        _ => return None,
    };
    Some(result_from_parts(
        runtime::ui_lang::tr_static("内置服务商规则", "Built-in provider rules", "Reglas de proveedor integradas"),
        preset.0,
        email,
        preset.1,
        preset.2,
        preset.3,
        preset.4,
        preset.5,
        preset.6,
        preset.7,
        preset.8,
    ))
}

#[allow(clippy::too_many_arguments)]
fn result_from_parts(
    source: &str,
    display_name: &str,
    email: &str,
    imap_host: &str,
    imap_port: u16,
    imap_security: MailSocketSecurity,
    smtp_enabled: bool,
    smtp_host: &str,
    smtp_port: u16,
    smtp_security: MailSocketSecurity,
    notes: Vec<&str>,
) -> MailAutoconfigResult {
    MailAutoconfigResult {
        source: source.to_string(),
        display_name: display_name.to_string(),
        imap_host: imap_host.to_string(),
        imap_port,
        imap_security,
        imap_username: email.to_string(),
        smtp_enabled,
        smtp_host: smtp_host.to_string(),
        smtp_port,
        smtp_security,
        smtp_username: email.to_string(),
        notes: notes.into_iter().map(str::to_string).collect(),
    }
}

fn guess_from_domain(email: &str, domain: &str) -> MailAutoconfigResult {
    result_from_parts(
        runtime::ui_lang::tr_static("通用域名猜测", "Generic domain guess", "Suposición genérica por dominio"),
        domain,
        email,
        &format!("imap.{domain}"),
        993,
        MailSocketSecurity::Tls,
        true,
        &format!("smtp.{domain}"),
        465,
        MailSocketSecurity::Tls,
        vec![runtime::ui_lang::tr_static("没有找到 Thunderbird Autoconfig 记录，已按常见 IMAP/SMTP 主机名生成配置；如测试失败，请手动修改服务器参数。", "No Thunderbird Autoconfig record was found, so the settings were built from common IMAP/SMTP host names. If the test fails, edit the server settings by hand.", "No se encontró ningún registro de Thunderbird Autoconfig, así que la configuración se generó con nombres de host IMAP/SMTP habituales. Si la prueba falla, edita a mano los datos del servidor.")],
    )
}
