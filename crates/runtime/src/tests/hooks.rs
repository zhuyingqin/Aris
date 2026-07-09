use super::{HookRunResult, HookRunner};
use crate::config::{RuntimeFeatureConfig, RuntimeHookConfig};

#[test]
fn allows_exit_code_zero_and_captures_stdout() {
    let runner = HookRunner::new(RuntimeHookConfig::new(
        vec![shell_snippet("printf 'pre ok'")],
        Vec::new(),
    ));

    let result = runner.run_pre_tool_use("Read", r#"{"path":"README.md"}"#);

    assert_eq!(result, HookRunResult::allow(vec!["pre ok".to_string()]));
}

#[test]
fn denies_exit_code_two() {
    let runner = HookRunner::new(RuntimeHookConfig::new(
        vec![shell_snippet("printf 'blocked by hook'; exit 2")],
        Vec::new(),
    ));

    let result = runner.run_pre_tool_use("Bash", r#"{"command":"pwd"}"#);

    assert!(result.is_denied());
    assert_eq!(result.messages(), &["blocked by hook".to_string()]);
}

#[test]
fn warns_for_other_non_zero_statuses() {
    let runner = HookRunner::from_feature_config(&RuntimeFeatureConfig::default().with_hooks(
        RuntimeHookConfig::new(
            vec![shell_snippet("printf 'warning hook'; exit 1")],
            Vec::new(),
        ),
    ));

    let result = runner.run_pre_tool_use("Edit", r#"{"file":"src/lib.rs"}"#);

    assert!(!result.is_denied());
    assert!(result
        .messages()
        .iter()
        .any(|message| message.contains("allowing tool execution to continue")));
}

#[cfg(windows)]
fn shell_snippet(script: &str) -> String {
    script
        .replace("printf '", "echo ")
        .replace("'; exit ", " & exit /b ")
        .replace('\'', "")
}

#[cfg(not(windows))]
fn shell_snippet(script: &str) -> String {
    script.to_string()
}
