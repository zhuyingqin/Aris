//! App tiers, as adjusted by the rollout plan
//! (`docs/development-logic/computer-use-rollout-plan.md`, adjustment 2):
//! unknown apps are *not* fully operable by default, and terminals/IDEs lose
//! the design draft's "left click only" tier.
//!
//! R0 only classifies; nothing here grants anything. Identity is the process
//! image file name, never the window title (titles can be set by documents
//! and web pages).

use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Tier {
    /// Never listed by title, snapshotted, captured, or targeted.
    Protected,
    /// May be observed after consent; operating it must go through a
    /// dedicated tool (browser tools, the Shell tool) instead.
    ReadOnly,
    /// Unknown to the built-in lists: observation needs consent, and any
    /// action needs the app to be explicitly allow-listed first.
    RequiresGrant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Classification {
    pub tier: Tier,
    pub reason: &'static str,
}

/// Window-title prefix of the R0 test window (`benchmarks/computer-use/fixtures/desktop/fixture-window.ps1`).
pub const FIXTURE_TITLE_PREFIX: &str = "SomniQ CU R0 Fixture";

const SELF: &[&str] = &["aris-desktop.exe", "somniq studio.exe", "somniq-studio.exe"];

const SYSTEM_SECURITY: &[&str] = &[
    "consent.exe",
    "credentialuibroker.exe",
    "logonui.exe",
    "lockapp.exe",
    "sechealthui.exe",
    "securityhealthhost.exe",
    "systemsettings.exe",
    "taskmgr.exe",
    "useraccountcontrolsettings.exe",
    "windowsdefender.exe",
];

const PASSWORD_MANAGERS: &[&str] = &[
    "1password.exe",
    "bitwarden.exe",
    "dashlane.exe",
    "enpass.exe",
    "keepass.exe",
    "keepassxc.exe",
    "lastpass.exe",
    "roboform.exe",
];

/// Apps that send what is on screen to other people. Seeing them is enough to
/// carry private conversations into a model request, so they are protected
/// (decided for R2, 2026-11-25).
const MESSAGING: &[&str] = &[
    "qq.exe",
    "tim.exe",
    "weixin.exe",
    "wechat.exe",
    "wxwork.exe",
    "dingtalk.exe",
    "feishu.exe",
    "lark.exe",
    "telegram.exe",
    "whatsapp.exe",
    "whatsapp.root.exe",
    "signal.exe",
    "slack.exe",
    "teams.exe",
    "ms-teams.exe",
    "discord.exe",
    "skype.exe",
    "zoom.exe",
    "thunderbird.exe",
    "outlook.exe",
    "olk.exe",
    "foxmail.exe",
    "mailmaster.exe",
];

/// Remote-desktop clients drive another machine; other AI agents' clients
/// have their own approval surfaces `SomniQ` must never answer.
const REMOTE_AND_AGENTS: &[&str] = &[
    "rustdesk.exe",
    "teamviewer.exe",
    "anydesk.exe",
    "todesk.exe",
    "sunloginclient.exe",
    "mstsc.exe",
    "parsecd.exe",
    "claude.exe",
    "chatgpt.exe",
    "doubao.exe",
];

const BROWSERS: &[&str] = &[
    "msedge.exe",
    "chrome.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
    "arc.exe",
    "iexplore.exe",
    "360se.exe",
    "360chrome.exe",
    "qqbrowser.exe",
    "sogouexplorer.exe",
];

const TERMINALS_AND_IDES: &[&str] = &[
    "windowsterminal.exe",
    "wt.exe",
    "openconsole.exe",
    "conhost.exe",
    "cmd.exe",
    "powershell.exe",
    "pwsh.exe",
    "mintty.exe",
    "code.exe",
    "cursor.exe",
    "windsurf.exe",
    "antigravity.exe",
    "devenv.exe",
    "idea64.exe",
    "pycharm64.exe",
    "clion64.exe",
    "webstorm64.exe",
    "rider64.exe",
    "sublime_text.exe",
];

/// Lower-cased file name of a process image path (accepts `\` and `/`).
#[must_use]
pub fn exe_file_name(image_path: &str) -> String {
    image_path
        .rsplit(['\\', '/'])
        .next()
        .unwrap_or(image_path)
        .trim()
        .to_lowercase()
}

#[must_use]
pub fn classify(image_path: &str) -> Classification {
    let name = exe_file_name(image_path);
    let name = name.as_str();
    if name.is_empty() {
        return Classification {
            tier: Tier::Protected,
            reason: "进程身份读不到（常见于以管理员运行的窗口），按禁区处理",
        };
    }
    if SELF.contains(&name) {
        return Classification {
            tier: Tier::Protected,
            reason: "SomniQ 自己的窗口（含审批卡片）",
        };
    }
    if SYSTEM_SECURITY.contains(&name) {
        return Classification {
            tier: Tier::Protected,
            reason: "系统凭据、安全或设置界面",
        };
    }
    if PASSWORD_MANAGERS.contains(&name) {
        return Classification {
            tier: Tier::Protected,
            reason: "密码管理器",
        };
    }
    if MESSAGING.contains(&name) {
        return Classification {
            tier: Tier::Protected,
            reason: "聊天、邮件或会议应用：内容属于与他人的往来",
        };
    }
    if REMOTE_AND_AGENTS.contains(&name) {
        return Classification {
            tier: Tier::Protected,
            reason: "远程桌面或其他 AI Agent 客户端",
        };
    }
    if BROWSERS.contains(&name) {
        return Classification {
            tier: Tier::ReadOnly,
            reason: "浏览器：网页操作走浏览器工具",
        };
    }
    if TERMINALS_AND_IDES.contains(&name) {
        return Classification {
            tier: Tier::ReadOnly,
            reason: "终端或 IDE：命令走 Shell 工具",
        };
    }
    if name == "applicationframehost.exe" {
        return Classification {
            tier: Tier::RequiresGrant,
            reason: "UWP 外框进程：真实应用在子窗口里，身份要按子窗口的进程判定",
        };
    }
    Classification {
        tier: Tier::RequiresGrant,
        reason: "未在内置清单中：看需要同意，操作需要先加入允许清单",
    }
}

/// The only windows the R0 action probe may act on: the PowerShell-hosted
/// fixture window. Both the title prefix and the host process must match, so
/// a document or web page titled like the fixture is not enough.
#[must_use]
pub fn is_fixture_window(title: &str, image_path: &str) -> bool {
    let host = exe_file_name(image_path);
    title.starts_with(FIXTURE_TITLE_PREFIX) && (host == "powershell.exe" || host == "pwsh.exe")
}

#[cfg(test)]
#[path = "tests/policy.rs"]
mod tests;
