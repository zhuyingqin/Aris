//! The permission decision for an autonomous task turn.
//!
//! `DesktopPermissionPrompter` blocks until a human answers. A work task has no
//! human attached — the user queued it and walked away — so reusing it would
//! turn "this tool needs elevation" into a run that hangs forever, which is the
//! failure mode `engine.rs` already documents for autonomous workflow turns and
//! solves by allowing only read-only tools.
//!
//! A work task cannot take that way out: its whole purpose is to change files.
//! So it takes the other one — decide immediately, and rely on the worktree for
//! containment rather than on a prompt. This is what the isolation is *for*:
//! writes land in a throwaway checkout on a throwaway branch, and nothing
//! reaches the user's own working copy until they accept the diff.
//!
//! The line is drawn at the workspace boundary, not at "is this tool scary":
//! anything satisfied by `WorkspaceWrite` is allowed, and `DangerFullAccess` —
//! the mode that means "outside the workspace" — is refused with a reason the
//! model sees in its tool result, so it can adapt instead of retrying blindly.

use runtime::{PermissionMode, PermissionPrompter, PermissionRequest, PermissionPromptDecision};

/// Non-blocking prompter for a task turn.
pub(crate) struct WorktreePermissionPrompter {
    /// Recorded for the failure message so a denied task says which checkout
    /// it was confined to rather than just "denied".
    worktree_path: String,
}

impl WorktreePermissionPrompter {
    pub(crate) fn new(worktree_path: impl Into<String>) -> Self {
        Self {
            worktree_path: worktree_path.into(),
        }
    }
}

impl PermissionPrompter for WorktreePermissionPrompter {
    fn decide(&mut self, request: &PermissionRequest) -> PermissionPromptDecision {
        match request.required_mode {
            // Contained by the worktree. Allowed without asking, because there
            // is nobody to ask and the blast radius is a branch the user has
            // not accepted yet.
            PermissionMode::ReadOnly
            | PermissionMode::WorkspaceWrite
            | PermissionMode::Prompt
            | PermissionMode::Allow => PermissionPromptDecision::Allow,
            // Escapes the worktree, so the isolation argument no longer holds
            // and there is no human to override it.
            PermissionMode::DangerFullAccess => PermissionPromptDecision::Deny {
                reason: format!(
                    "`{}` needs access outside the task's isolated worktree ({}). A background \
                     work task runs without anyone to approve that, so it was refused. Keep the \
                     work inside the task's own checkout, or run this from Chat instead.",
                    request.tool_name, self.worktree_path
                ),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(tool_name: &str, required_mode: PermissionMode) -> PermissionRequest {
        PermissionRequest {
            tool_name: tool_name.to_string(),
            input: String::new(),
            current_mode: PermissionMode::WorkspaceWrite,
            required_mode,
        }
    }

    /// The property the whole design depends on: no input makes this block or
    /// defer. Every mode returns a decision on the spot.
    #[test]
    fn every_mode_decides_immediately() {
        let mut prompter = WorktreePermissionPrompter::new("/tmp/worktree");
        for mode in [
            PermissionMode::ReadOnly,
            PermissionMode::WorkspaceWrite,
            PermissionMode::Prompt,
            PermissionMode::Allow,
            PermissionMode::DangerFullAccess,
        ] {
            let decision = prompter.decide(&request("edit_file", mode));
            assert!(
                matches!(
                    decision,
                    PermissionPromptDecision::Allow | PermissionPromptDecision::Deny { .. }
                ),
                "{mode:?} did not decide"
            );
        }
    }

    /// A task must be able to write, or it cannot do its job.
    #[test]
    fn writing_inside_the_worktree_is_allowed() {
        let mut prompter = WorktreePermissionPrompter::new("/tmp/worktree");
        assert_eq!(
            prompter.decide(&request("edit_file", PermissionMode::WorkspaceWrite)),
            PermissionPromptDecision::Allow
        );
    }

    /// And it must not be able to reach past the isolation that justifies the
    /// auto-approval above.
    #[test]
    fn escaping_the_worktree_is_denied_with_an_actionable_reason() {
        let mut prompter = WorktreePermissionPrompter::new("/tmp/worktree");
        let decision = prompter.decide(&request("bash", PermissionMode::DangerFullAccess));
        let PermissionPromptDecision::Deny { reason } = decision else {
            panic!("full access must be denied");
        };
        // The model reads this as a tool result, so it has to say what was
        // refused and what to do instead — not just "denied".
        assert!(reason.contains("bash"), "reason omits the tool: {reason}");
        assert!(reason.contains("/tmp/worktree"), "reason omits the boundary: {reason}");
        assert!(reason.contains("Chat"), "reason offers no alternative: {reason}");
    }
}
