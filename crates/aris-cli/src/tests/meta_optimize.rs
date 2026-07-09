use super::*;

#[test]
fn test_valid_skill_names() {
    assert!(is_valid_skill_name("auto-review-loop"));
    assert!(is_valid_skill_name("paper-write"));
    assert!(is_valid_skill_name("arxiv"));
    assert!(is_valid_skill_name("dse-loop"));
}

#[test]
fn test_invalid_skill_names() {
    assert!(!is_valid_skill_name(""));
    assert!(!is_valid_skill_name(".."));
    assert!(!is_valid_skill_name("../../.zshrc"));
    assert!(!is_valid_skill_name("Auto-Review")); // uppercase
    assert!(!is_valid_skill_name("-starts-with-hyphen"));
    assert!(!is_valid_skill_name("has space"));
    assert!(!is_valid_skill_name("has/slash"));
    assert!(!is_valid_skill_name("has.dot"));
}
