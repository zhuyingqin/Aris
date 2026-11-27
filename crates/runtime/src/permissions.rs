use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PermissionMode {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
    Prompt,
    Allow,
}

impl PermissionMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::WorkspaceWrite => "workspace-write",
            Self::DangerFullAccess => "danger-full-access",
            Self::Prompt => "prompt",
            Self::Allow => "allow",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionRequest {
    pub tool_name: String,
    pub input: String,
    pub current_mode: PermissionMode,
    pub required_mode: PermissionMode,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionPromptDecision {
    Allow,
    Deny { reason: String },
}

pub trait PermissionPrompter {
    fn decide(&mut self, request: &PermissionRequest) -> PermissionPromptDecision;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionOutcome {
    Allow,
    Deny { reason: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PermissionPolicy {
    active_mode: PermissionMode,
    tool_requirements: BTreeMap<String, PermissionMode>,
    /// Refuse every tool that has no registered requirement, whatever the
    /// active mode. Without this, an unregistered name counts as needing
    /// `DangerFullAccess`, so under that mode (the desktop default) a model can
    /// call a tool that was deliberately left out of a narrowed catalog just by
    /// naming it.
    catalog_only: bool,
}

impl PermissionPolicy {
    #[must_use]
    pub fn new(active_mode: PermissionMode) -> Self {
        Self {
            active_mode,
            tool_requirements: BTreeMap::new(),
            catalog_only: false,
        }
    }

    /// Only tools registered with [`Self::with_tool_requirement`] can ever be
    /// allowed; any other name is denied outright, without a prompt and even
    /// in `Allow` mode. For sessions whose catalog is an allow-list (computer
    /// use), where "not offered" has to mean "not callable".
    #[must_use]
    pub fn with_catalog_only(mut self) -> Self {
        self.catalog_only = true;
        self
    }

    #[must_use]
    pub fn is_catalog_only(&self) -> bool {
        self.catalog_only
    }

    #[must_use]
    pub fn with_tool_requirement(
        mut self,
        tool_name: impl Into<String>,
        required_mode: PermissionMode,
    ) -> Self {
        self.tool_requirements
            .insert(tool_name.into(), required_mode);
        self
    }

    #[must_use]
    pub fn active_mode(&self) -> PermissionMode {
        self.active_mode
    }

    #[must_use]
    pub fn required_mode_for(&self, tool_name: &str) -> PermissionMode {
        self.tool_requirements
            .get(tool_name)
            .copied()
            .unwrap_or(PermissionMode::DangerFullAccess)
    }

    #[must_use]
    pub fn authorize(
        &self,
        tool_name: &str,
        input: &str,
        mut prompter: Option<&mut dyn PermissionPrompter>,
    ) -> PermissionOutcome {
        // Checked before every mode shortcut: a catalog-only policy has no
        // mode, prompt, or answer that can make an unlisted tool callable.
        if self.catalog_only && !self.tool_requirements.contains_key(tool_name) {
            return PermissionOutcome::Deny {
                reason: format!(
                    "tool '{tool_name}' is not available in this session; only the tools offered this turn can be called, and this cannot be approved"
                ),
            };
        }
        let current_mode = self.active_mode();
        let required_mode = self.required_mode_for(tool_name);
        // Allow mode always bypasses checks.
        if current_mode == PermissionMode::Allow {
            return PermissionOutcome::Allow;
        }
        // For non-Prompt modes, the Ord ranking (ReadOnly < WorkspaceWrite <
        // DangerFullAccess) means a higher mode includes the rights of lower
        // ones. Prompt is intentionally NOT a level on this scale — it means
        // "ask the user before every tool", so it must fall through to the
        // prompter regardless of where Ord would place it. Without this
        // exception the derived `Ord` placed Prompt above DangerFullAccess,
        // so `current_mode >= required_mode` short-circuited and Prompt
        // silently granted every request — the exact opposite of its intent.
        if current_mode != PermissionMode::Prompt && current_mode >= required_mode {
            return PermissionOutcome::Allow;
        }

        let request = PermissionRequest {
            tool_name: tool_name.to_string(),
            input: input.to_string(),
            current_mode,
            required_mode,
        };

        if current_mode == PermissionMode::Prompt
            || (current_mode == PermissionMode::WorkspaceWrite
                && required_mode == PermissionMode::DangerFullAccess)
        {
            return match prompter.as_mut() {
                Some(prompter) => match prompter.decide(&request) {
                    PermissionPromptDecision::Allow => PermissionOutcome::Allow,
                    PermissionPromptDecision::Deny { reason } => PermissionOutcome::Deny { reason },
                },
                None => PermissionOutcome::Deny {
                    reason: format!(
                        "tool '{tool_name}' requires approval to escalate from {} to {}",
                        current_mode.as_str(),
                        required_mode.as_str()
                    ),
                },
            };
        }

        PermissionOutcome::Deny {
            reason: format!(
                "tool '{tool_name}' requires {} permission; current mode is {}",
                required_mode.as_str(),
                current_mode.as_str()
            ),
        }
    }
}

#[cfg(test)]
#[path = "tests/permissions.rs"]
mod tests;
