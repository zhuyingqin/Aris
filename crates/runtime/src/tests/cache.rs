use super::*;

#[test]
fn extract_one_writes_simple_file() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    extract_one(&tmp, "tools/foo.py", "print('hi')").unwrap();
    let dst = tmp.join("tools").join("foo.py");
    assert!(dst.is_file(), "{} should exist", dst.display());
    assert_eq!(std::fs::read_to_string(&dst).unwrap(), "print('hi')");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn extract_one_rejects_absolute_key() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let err = extract_one(&tmp, "/etc/passwd", "evil").unwrap_err();
    assert!(
        err.contains("absolute") || err.contains("root-dir"),
        "got: {err}"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn extract_one_rejects_parent_segment() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    let err = extract_one(&tmp, "tools/../escape.py", "evil").unwrap_err();
    assert!(err.contains("parent-dir"), "got: {err}");
    let _ = std::fs::remove_dir_all(&tmp);
}

// Unix only: fs::rename is atomic overwrite. On Windows fs::rename fails
// when target exists; cache contract is "first writer wins with identical
// content", so we don't test overwrite there.
#[cfg(unix)]
#[test]
fn extract_one_overwrites_existing() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    extract_one(&tmp, "tools/x.py", "v1").unwrap();
    extract_one(&tmp, "tools/x.py", "v2").unwrap();
    let got = std::fs::read_to_string(tmp.join("tools/x.py")).unwrap();
    assert_eq!(got, "v2", "should overwrite existing content");
    let _ = std::fs::remove_dir_all(&tmp);
}

#[test]
fn extract_one_rejects_root_segment() {
    let tmp = std::env::temp_dir().join(format!("aris-test-{}", rand_suffix()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).unwrap();
    // Leading "/" — Path::new will produce a RootDir component
    let err = extract_one(&tmp, "/tools/x.py", "evil").unwrap_err();
    // Either is_absolute path or root-dir component is caught; both messages OK
    assert!(
        err.contains("absolute") || err.contains("root-dir"),
        "got: {err}"
    );
    let _ = std::fs::remove_dir_all(&tmp);
}

/// v0.4.9 T29: every bundle key cited inside a bundled SKILL.md prose
/// must resolve to an actual entry in BUNDLED_RESOURCES. Guards against
/// the H6 regression where SKILL.md `python3 tools/foo.py` references
/// silently 404'd because foo.py was never bundled.
///
/// Detection rule (deliberately narrow to avoid false positives from
/// prose mentions): we match the runtime-injected `$ARIS_CACHE_DIR/`
/// substitution pattern that v0.4.8+ SKILL.md migrations use, and we
/// match unprefixed `python3 tools/<helper>` literals that survived
/// from the v0.4.7 era. shared-references/* doesn't need direct
/// invocation references; templates/ are read via fs paths not exec.
#[test]
fn bundle_inventory_skill_md_refs_resolve_to_bundled_resources() {
    use regex::Regex;
    let bundled_keys: std::collections::HashSet<&'static str> =
        crate::BUNDLED_RESOURCES.iter().map(|(k, _)| *k).collect();

    // Match either:
    //   "$ARIS_CACHE_DIR/<key>" or "${ARIS_CACHE_DIR:-.}/<key>"
    //   bare "tools/<helper>.{py,sh}" (legacy literal still in some SKILLs)
    let cache_re = Regex::new(
        r#"\$\{?ARIS_CACHE_DIR(?::-[^}]*)?\}?/((?:tools|skills/[a-zA-Z0-9_-]+|shared-references|shared-governance)/[a-zA-Z0-9_./-]+\.(?:py|sh|tex|cls|bst|md|toml|yaml|yml|json))"#,
    )
    .expect("compile cache_re");
    let legacy_re =
        Regex::new(r#"(?m)\bpython3\s+(?:"|)?(tools/[a-zA-Z0-9_./-]+\.(?:py|sh))(?:"|)?"#)
            .expect("compile legacy_re");

    let mut missing: Vec<(String, String)> = Vec::new();
    for (skill_name, content) in crate::BUNDLED_SKILLS {
        for cap in cache_re.captures_iter(content) {
            let key = &cap[1];
            if !bundled_keys.contains(key) {
                missing.push((skill_name.to_string(), key.to_string()));
            }
        }
        for cap in legacy_re.captures_iter(content) {
            let key = &cap[1];
            if !bundled_keys.contains(key) {
                missing.push((skill_name.to_string(), key.to_string()));
            }
        }
    }

    assert!(
        missing.is_empty(),
        "SKILL.md references {} bundle key(s) that are NOT in BUNDLED_RESOURCES:\n{}",
        missing.len(),
        missing
            .iter()
            .map(|(s, k)| format!("  /{s}: {k}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// v0.4.11 — verify the SKILLS_SOURCE_COMMIT file recorded by
/// `tools/sync_main_skills.sh` exists and looks like a valid 40-char
/// hex SHA.
///
/// If `origin/main` resolves (CI w/ `fetch-depth: 0`), also check
/// the pin is an ancestor of `origin/main` (warn-only — release
/// commits intentionally outpace the source-commit pin by one).
///
/// Hard-fails if the file is missing or malformed so the next
/// release can't ship a bundle of unknown provenance.
#[test]
fn skills_source_commit_pin_present_and_well_formed() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join("SKILLS_SOURCE_COMMIT");
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|err| {
        panic!(
            "missing {} ({}). Run `bash tools/sync_main_skills.sh` first; \
             see idea-stage/v0.4.11/sync_plan.md",
            path.display(),
            err
        )
    });
    let commit = raw.trim();
    assert_eq!(
        commit.len(),
        40,
        "SKILLS_SOURCE_COMMIT must be a 40-char SHA, got {:?} ({} chars)",
        commit,
        commit.len()
    );
    assert!(
        commit.chars().all(|c| c.is_ascii_hexdigit()),
        "SKILLS_SOURCE_COMMIT must be lowercase hex, got {:?}",
        commit
    );

    // Best-effort: if git + origin/main is reachable, verify the pin
    // is an ancestor of origin/main. Skipped silently when the
    // current shell can't resolve origin/main (local dev, sandbox).
    let main_check = crate::hidden_command("git")
        .args(["rev-parse", "--verify", "--quiet", "origin/main"])
        .output();
    if let Ok(out) = main_check {
        if out.status.success() {
            let main_sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !main_sha.is_empty() && main_sha != commit {
                let ancestor = crate::hidden_command("git")
                    .args(["merge-base", "--is-ancestor", commit, &main_sha])
                    .status();
                if let Ok(status) = ancestor {
                    if !status.success() {
                        eprintln!(
                            "WARN: SKILLS_SOURCE_COMMIT {} is NOT an ancestor of \
                             origin/main {}. The skills bundle may be stale or \
                             diverged. Re-run sync_main_skills.sh before releasing.",
                            commit, main_sha
                        );
                    }
                }
            }
        }
    }
}

/// v0.4.11 — extended helper-reference resolver coverage.
///
/// Existing `bundle_inventory_skill_md_refs_resolve_to_bundled_resources`
/// covers `$ARIS_CACHE_DIR/...` and `python3 tools/...`. Main SKILL.md
/// also uses two more resolver layers which were previously uncovered:
///   - `.aris/tools/<helper>` (canonical resolver Layer 1)
///   - `${ARIS_REPO}/tools/<helper>` or `<ARIS_REPO>/tools/<helper>`
///     (resolver Layer 2 — user override / dev mode)
#[test]
fn skill_md_aris_tools_and_repo_refs_resolve_to_bundled() {
    use regex::Regex;
    use std::collections::HashSet;

    let bundled_keys: HashSet<&'static str> =
        crate::BUNDLED_RESOURCES.iter().map(|(k, _)| *k).collect();

    let aris_tools_re = Regex::new(
        r#"\.aris/(tools/[a-zA-Z0-9_./-]+\.(?:py|sh|tex|cls|bst|md|toml|yaml|yml|json))"#,
    )
    .expect("compile aris_tools_re");
    let repo_tools_re = Regex::new(
        r#"(?:\$\{?ARIS_REPO\}?|<ARIS_REPO>)/(tools/[a-zA-Z0-9_./-]+\.(?:py|sh|tex|cls|bst|md|toml|yaml|yml|json))"#,
    )
    .expect("compile repo_tools_re");

    let mut missing: Vec<(String, String)> = Vec::new();
    for (skill_name, content) in crate::BUNDLED_SKILLS {
        for cap in aris_tools_re.captures_iter(content) {
            let key = &cap[1];
            if !bundled_keys.contains(key) {
                missing.push((skill_name.to_string(), key.to_string()));
            }
        }
        for cap in repo_tools_re.captures_iter(content) {
            let key = &cap[1];
            if !bundled_keys.contains(key) {
                missing.push((skill_name.to_string(), key.to_string()));
            }
        }
    }

    assert!(
        missing.is_empty(),
        "SKILL.md references {} `.aris/tools/...` or `$ARIS_REPO/tools/...` \
         key(s) that are NOT in BUNDLED_RESOURCES:\n{}",
        missing.len(),
        missing
            .iter()
            .map(|(s, k)| format!("  /{s}: {k}"))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

/// v0.4.11 — cross-skill references in SKILL.md should resolve to
/// other bundled skills. Warn-only (not hard fail) because SKILL.md
/// may intentionally mention not-yet-bundled or planned skills, and
/// we don't want to block emergency hot-fixes when main is mid-
/// refactor.
///
/// Run with `cargo test ... -- --nocapture` to see warning output.
#[test]
fn skill_md_cross_skill_references_bundled_warn_only() {
    use regex::Regex;
    use std::collections::HashSet;

    let bundled_names: HashSet<&'static str> =
        crate::BUNDLED_SKILLS.iter().map(|(n, _)| *n).collect();

    let re = Regex::new(
        r#"(?i)\b(?:Use|See|Via|The|Run|Invoke|Calls?|Runs?|Trigger)\s+`?/([a-z][a-z0-9-]+)`?(?P<after>\.?(?:\s+(?:skill|workflow|pipeline)\b|[\s,;:!?)）]|$))"#,
    )
    .expect("compile cross-skill regex");

    let mut unresolved: Vec<(&'static str, String)> = Vec::new();
    for (skill_name, content) in crate::BUNDLED_SKILLS {
        for cap in re.captures_iter(content) {
            let referenced = &cap[1];
            if !bundled_names.contains(referenced) {
                unresolved.push((*skill_name, referenced.to_string()));
            }
        }
    }

    if !unresolved.is_empty() {
        let mut seen: HashSet<(&'static str, String)> = HashSet::new();
        let mut summary: Vec<String> = Vec::new();
        for (s, r) in &unresolved {
            let key = (*s, r.clone());
            if seen.insert(key) {
                summary.push(format!("  /{}: -> /{}", s, r));
            }
        }
        eprintln!(
            "WARN: {} cross-skill reference(s) point to non-bundled \
             skill(s). This is allowed (roadmap mentions, mid-refactor), \
             but verify each before release:\n{}",
            summary.len(),
            summary.join("\n")
        );
    }
}
