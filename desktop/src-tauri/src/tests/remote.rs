use super::*;

fn temp_state(name: &str) -> (RemoteAgentState, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "somniq-remote-{name}-{}",
        remote_protocol::DeviceId::new()
    ));
    let state = RemoteAgentState::at_path(root.join("agent.json"));
    (state, root)
}

fn grant(state: &RemoteAgentState, id: &str, scopes: &[RemoteScope]) {
    with_store(state, |store| {
        store.enabled = true;
        store.devices.push(RemoteDevice {
            id: id.to_string(),
            label: format!("device-{id}"),
            fingerprint: "f".repeat(32),
            scopes: scopes.iter().copied().collect(),
            paired_at: 1,
            last_seen_at: None,
            revoked_at: None,
            descriptor: None,
            session_id: None,
        });
        Ok(())
    })
    .expect("grant test device");
}

#[test]
fn gateway_urls_require_tls_except_local_development() {
    assert_eq!(
        normalize_gateway_url("https://remote.example.test/").expect("https accepted"),
        "https://remote.example.test"
    );
    assert!(normalize_gateway_url("http://remote.example.test").is_err());
    assert!(normalize_gateway_url("file:///tmp/agent").is_err());
    assert!(normalize_gateway_url("http://localhost.evil.test").is_err());
    assert!(normalize_gateway_url("http://localhost@evil.test").is_err());
    assert!(normalize_gateway_url("http://127.0.0.1.evil.test").is_err());
    assert!(normalize_gateway_url("http://127.0.0.1:8787").is_ok());
    assert!(normalize_gateway_url("http://[::1]:8787").is_ok());
}

#[test]
fn gateway_pairing_expiry_replaces_the_provisional_qr_expiry() {
    let signing = DeviceSigningKey::generate();
    let agreement = KeyAgreementSecret::generate();
    let mut invitation = PairingInvitation::new(
        DeviceDescriptor::new(
            DeviceId::new(),
            DeviceKind::Desktop,
            "SomniQ desktop",
            signing.public_key(),
            agreement.public_key(),
        )
        .expect("valid desktop descriptor"),
        "https://gateway.example.test",
        1_300,
    )
    .expect("valid provisional invitation");
    let response = GatewayStartPairingResponse {
        pairing_id: invitation.pairing_id.to_string(),
        // This deliberately differs from the desktop's proposed expiry: the
        // gateway is the authority after it has accepted the pairing.
        expires_at_unix_ms: 1_100,
        desktop_token: None,
    };

    apply_gateway_pairing_expiry(&mut invitation, &response)
        .expect("future gateway expiry is accepted");

    assert_eq!(invitation.expires_at_unix_ms, 1_100);
    let deep_link = pairing_qr_deep_link(&invitation).expect("QR deep link");
    let encoded = deep_link.split_once("#p=").expect("QR has fragment").1;
    let payload =
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, encoded)
            .expect("QR payload is base64url");
    let qr_invitation: PairingInvitation =
        serde_json::from_slice(&payload).expect("QR payload restores invitation");
    assert_eq!(
        qr_invitation.expires_at_unix_ms,
        response.expires_at_unix_ms
    );
}

#[test]
fn gateway_pairing_expiry_rejects_mismatched_or_invalid_responses() {
    let signing = DeviceSigningKey::generate();
    let agreement = KeyAgreementSecret::generate();
    let mut invitation = PairingInvitation::new(
        DeviceDescriptor::new(
            DeviceId::new(),
            DeviceKind::Desktop,
            "SomniQ desktop",
            signing.public_key(),
            agreement.public_key(),
        )
        .expect("valid desktop descriptor"),
        "https://gateway.example.test",
        1_300,
    )
    .expect("valid provisional invitation");
    let provisional_expiry = invitation.expires_at_unix_ms;

    let mismatched = GatewayStartPairingResponse {
        pairing_id: PairingId::new().to_string(),
        expires_at_unix_ms: 1_900,
        desktop_token: None,
    };
    assert!(apply_gateway_pairing_expiry(&mut invitation, &mismatched)
        .expect_err("mismatched response is rejected")
        .contains("mismatched pairing identifier"));
    assert_eq!(invitation.expires_at_unix_ms, provisional_expiry);

    let invalid_expiry = GatewayStartPairingResponse {
        pairing_id: invitation.pairing_id.to_string(),
        expires_at_unix_ms: 0,
        desktop_token: None,
    };
    assert!(
        apply_gateway_pairing_expiry(&mut invitation, &invalid_expiry)
            .expect_err("invalid response is rejected")
            .contains("invalid pairing expiry")
    );
    assert_eq!(invitation.expires_at_unix_ms, provisional_expiry);
}

#[test]
fn direct_p2p_uses_explicit_stun_only_and_preserves_tcp_relay_fallback() {
    assert_eq!(
        normalize_ice_servers(vec![
            "stun:stun.example.test:3478".to_string(),
            "STUN:stun.example.test:3478".to_string(),
            "stuns:stun.example.test:5349".to_string(),
        ])
        .expect("valid STUN configuration"),
        vec![
            "stun:stun.example.test:3478".to_string(),
            "stuns:stun.example.test:5349".to_string(),
        ]
    );
    assert!(normalize_ice_servers(vec!["turn:relay.example.test:3478".to_string()]).is_err());
    assert!(normalize_ice_servers(vec!["stun:user@relay.example.test:3478".to_string()]).is_err());
    assert!(normalize_ice_servers(vec!["https://relay.example.test".to_string()]).is_err());
}

#[test]
fn current_desktop_advertises_optional_workspace_commands() {
    assert_eq!(
        REMOTE_WORKSPACE_CAPABILITIES,
        &[
            remote_protocol::RemoteCapability::SetActiveProject,
            remote_protocol::RemoteCapability::GetChatModelOptions,
            remote_protocol::RemoteCapability::SetChatSessionModel,
        ]
    );
}

#[test]
fn pairing_qr_uses_a_same_origin_deep_link_with_a_fragment_payload() {
    let signing = DeviceSigningKey::generate();
    let agreement = KeyAgreementSecret::generate();
    let desktop = DeviceDescriptor::new(
        DeviceId::new(),
        DeviceKind::Desktop,
        "SomniQ desktop",
        signing.public_key(),
        agreement.public_key(),
    )
    .expect("valid desktop descriptor");
    let invitation = PairingInvitation::new(desktop, "https://gateway.example.test", i64::MAX)
        .expect("valid invitation");

    let deep_link = pairing_qr_deep_link(&invitation).expect("deep link");
    let (route, fragment) = deep_link
        .split_once('#')
        .expect("deep link carries fragment payload");
    assert_eq!(route, "https://gateway.example.test/pair");
    let encoded = fragment
        .strip_prefix("p=")
        .expect("fragment has invitation parameter");
    let decoded =
        base64::Engine::decode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, encoded)
            .expect("fragment is base64url");
    let restored: PairingInvitation =
        serde_json::from_slice(&decoded).expect("fragment restores invitation");
    assert_eq!(restored, invitation);
}

#[test]
fn transport_session_history_never_evicts_an_existing_pairing_context() {
    let mut store = RemoteStore::default();
    let first_phone = DeviceId::new().to_string();
    for index in 0..MAX_USED_TRANSPORT_SESSIONS_PER_DEVICE {
        record_transport_session(&mut store, &first_phone, &format!("first-{index}"))
            .expect("reserve bounded session history");
    }

    assert!(
        record_transport_session(&mut store, &first_phone, "one-too-many").is_err(),
        "a full device history fails closed rather than evicting a session ID"
    );
    assert!(
        record_transport_session(&mut store, &first_phone, "first-0").is_err(),
        "the oldest session ID remains permanently non-reusable"
    );

    let second_phone = DeviceId::new().to_string();
    record_transport_session(&mut store, &second_phone, "second-phone-first")
        .expect("one phone cannot exhaust another phone's replay history");
    assert_eq!(
        store
            .used_transport_sessions
            .iter()
            .filter(|used| used.device_id == first_phone)
            .count(),
        MAX_USED_TRANSPORT_SESSIONS_PER_DEVICE
    );
}

#[test]
fn full_legacy_transport_history_forces_repair_before_p2() {
    let phone = DeviceId::new().to_string();
    let mut store = RemoteStore {
        version: 1,
        enabled: true,
        ..RemoteStore::default()
    };
    store.devices.push(RemoteDevice {
        id: phone.clone(),
        label: "legacy phone".to_string(),
        fingerprint: "f".repeat(32),
        scopes: [RemoteScope::ReadProjectState].into_iter().collect(),
        paired_at: 1,
        last_seen_at: None,
        revoked_at: None,
        descriptor: None,
        session_id: None,
    });
    store.used_transport_sessions = (0..LEGACY_EVICTING_TRANSPORT_HISTORY_CAP)
        .map(|index| UsedTransportSession {
            session_id: format!("legacy-{index}"),
            device_id: phone.clone(),
            used_at: index as u64,
        })
        .collect();

    migrate_store(&mut store);

    assert_eq!(store.version, STORE_VERSION);
    assert!(store.devices[0].revoked_at.is_some());
    assert_eq!(store.pending_gateway_revocations, vec![phone]);
}

#[test]
fn paired_device_scopes_are_checked_and_revocation_is_immediate() {
    let (state, root) = temp_state("authorization");
    let phone = DeviceId::new().to_string();
    grant(&state, &phone, &[RemoteScope::ReadProjectState]);

    let scopes = authenticated_device_scopes(&state, &phone).expect("paired phone is allowed");
    assert!(scopes.contains(RemoteScope::ReadProjectState));
    assert!(!scopes.contains(RemoteScope::SendChatMessages));

    with_store(&state, |store| {
        let device = store
            .devices
            .iter_mut()
            .find(|device| device.id == phone)
            .expect("device exists");
        device.revoked_at = Some(42);
        Ok(())
    })
    .expect("revoke test device");
    assert!(authenticated_device_scopes(&state, &phone).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn gateway_revocation_drops_live_p2p_and_relay_state() {
    let (state, root) = temp_state("gateway-revocation");
    let phone = DeviceId::new();
    let phone_id = phone.to_string();
    let desktop = DeviceId::new();
    grant(&state, &phone_id, &[RemoteScope::ReadProjectState]);

    let session_id = SessionId::new();
    let session_id_text = session_id.to_string();
    let route = SessionRoute::new(session_id.clone(), phone.clone(), desktop);
    let wire = Arc::new(
        RemoteWireSession::new(
            phone_id.clone(),
            TransportKind::P2p,
            SessionKey::from_bytes([7_u8; 32]),
            route,
        )
        .expect("matching P2P session route"),
    );
    state
        .active_p2p_sessions
        .lock()
        .expect("P2P state lock")
        .insert(
            session_id_text.clone(),
            Arc::new(ReservedP2pSession {
                device_id: phone_id.clone(),
                session_id,
                wire,
                established: AtomicBool::new(true),
                received_ice_candidates: AtomicUsize::new(0),
            }),
        );
    state
        .active_relay_sessions
        .lock()
        .expect("relay state lock")
        .insert(format!("{phone_id}:{}", SessionId::new()));

    let events = mark_gateway_revoked_device(&state, &phone_id);

    assert_eq!(
        events
            .iter()
            .map(|event| (&event.device_id, &event.session_id))
            .collect::<Vec<_>>(),
        vec![(&phone_id, &session_id_text)]
    );
    assert!(state
        .active_p2p_sessions
        .lock()
        .expect("P2P state lock")
        .is_empty());
    assert!(state
        .active_relay_sessions
        .lock()
        .expect("relay state lock")
        .is_empty());
    assert!(authenticated_device_scopes(&state, &phone_id).is_err());
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn p2_pairing_allows_chat_execution_but_not_direct_run_control() {
    assert!(is_supported_remote_scope(RemoteScope::ReadProjectState));
    assert!(is_supported_remote_scope(RemoteScope::ReadTaskTimeline));
    assert!(is_supported_remote_scope(
        RemoteScope::ReadReviewConclusions
    ));
    assert!(is_supported_remote_scope(RemoteScope::SendChatMessages));
    assert!(!is_supported_remote_scope(RemoteScope::StopRuns));
}

#[test]
fn pairing_approval_grants_every_supported_requested_scope() {
    let requested = DeviceScopes::from([
        RemoteScope::ReadProjectState,
        RemoteScope::SendChatMessages,
        RemoteScope::StopRuns,
        RemoteScope::ReadReviewConclusions,
    ]);

    let granted = supported_requested_scopes(&requested);
    assert!(granted.contains(RemoteScope::ReadProjectState));
    assert!(granted.contains(RemoteScope::SendChatMessages));
    assert!(granted.contains(RemoteScope::ReadReviewConclusions));
    assert!(!granted.contains(RemoteScope::StopRuns));
    assert!(granted.is_subset_of(&requested));
}

#[test]
fn stale_gateway_credential_recovery_accepts_only_the_known_restart_outcome() {
    assert!(gateway_credential_was_rejected(
        "remote gateway request failed (401 Unauthorized): unauthorized"
    ));
    assert!(gateway_credential_was_rejected(
        "remote gateway request failed (404 Not Found): resource not found"
    ));
    assert!(!gateway_credential_was_rejected(
        "remote gateway request failed (404 Not Found): route missing"
    ));
    assert!(!gateway_credential_was_rejected(
        "remote gateway request failed (500 Internal Server Error): resource not found"
    ));
}

#[test]
fn remote_chat_idempotency_replays_only_the_same_completed_request() {
    let (state, root) = temp_state("remote-chat-idempotency");
    let first =
        reserve_remote_chat_idempotency(&state, "phone-a", "project-a", "retry-key", "digest-a")
            .expect("first request reserves a turn");
    let message_id = match first {
        RemoteChatReservation::New { message_id } => message_id,
        RemoteChatReservation::Completed { .. } => panic!("first request must be new"),
    };
    assert!(matches!(
        reserve_remote_chat_idempotency(&state, "phone-a", "project-a", "retry-key", "digest-a"),
        Err(ControlError::TemporarilyUnavailable { .. })
    ));
    complete_remote_chat_idempotency(
        &state,
        "phone-a",
        "project-a",
        "retry-key",
        "digest-a",
        "assistant reply".to_string(),
    )
    .expect("completed result is cached in memory");
    match reserve_remote_chat_idempotency(&state, "phone-a", "project-a", "retry-key", "digest-a")
        .expect("same retry reads the completed result")
    {
        RemoteChatReservation::Completed {
            message_id: replayed_id,
            text,
        } => {
            assert_eq!(replayed_id, message_id);
            assert_eq!(text, "assistant reply");
        }
        RemoteChatReservation::New { .. } => panic!("completed retry must not run again"),
    }
    assert!(matches!(
        reserve_remote_chat_idempotency(&state, "phone-a", "project-a", "retry-key", "digest-b"),
        Err(ControlError::Conflict)
    ));
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn remote_chat_response_is_bounded_on_utf8_boundaries() {
    let text = "中".repeat(MAX_REMOTE_CHAT_RESPONSE_BYTES);
    let truncated = truncate_remote_chat_response(text);
    assert!(truncated.contains("SomniQ truncated"));
    assert!(truncated.is_char_boundary(truncated.len()));
    assert!(truncated.len() <= MAX_REMOTE_CHAT_RESPONSE_BYTES);
    assert!(truncated.len() < MAX_RELAY_FRAME_BYTES);
}

#[test]
fn fresh_approval_can_replace_a_revoked_phone_but_not_an_active_one() {
    let phone = DeviceId::new().to_string();
    let mut store = RemoteStore {
        enabled: true,
        ..RemoteStore::default()
    };
    store.devices.push(RemoteDevice {
        id: phone.clone(),
        label: "old phone".to_string(),
        fingerprint: "a".repeat(32),
        scopes: [RemoteScope::ReadProjectState].into_iter().collect(),
        paired_at: 1,
        last_seen_at: None,
        revoked_at: Some(2),
        descriptor: None,
        session_id: Some(SessionId::new().to_string()),
    });
    store.pending_gateway_revocations.push(phone.clone());
    let refreshed = RemoteDevice {
        id: phone,
        label: "repaired phone".to_string(),
        fingerprint: "b".repeat(32),
        scopes: [RemoteScope::ReadTaskTimeline].into_iter().collect(),
        paired_at: 3,
        last_seen_at: None,
        revoked_at: None,
        descriptor: None,
        session_id: Some(SessionId::new().to_string()),
    };

    record_approved_device(&mut store, refreshed.clone()).expect("fresh approval replaces revoke");
    assert_eq!(store.devices.len(), 1);
    assert_eq!(store.devices[0].label, "repaired phone");
    assert!(store.devices[0].revoked_at.is_none());
    assert!(store.pending_gateway_revocations.is_empty());
    assert!(record_approved_device(&mut store, refreshed).is_err());
}

#[test]
fn removing_a_pairing_drops_the_local_device_and_queues_gateway_revocation() {
    let phone = DeviceId::new().to_string();
    let mut store = RemoteStore::default();
    store.devices.push(RemoteDevice {
        id: phone.clone(),
        label: "phone".to_string(),
        fingerprint: "f".repeat(32),
        scopes: [RemoteScope::ReadProjectState].into_iter().collect(),
        paired_at: 1,
        last_seen_at: None,
        revoked_at: None,
        descriptor: None,
        session_id: None,
    });

    remove_paired_device(&mut store, &phone).expect("pairing is removed");

    assert!(store.devices.is_empty());
    assert_eq!(store.pending_gateway_revocations, vec![phone.clone()]);
    assert!(remove_paired_device(&mut store, &phone).is_err());
}

#[test]
fn renderer_device_view_omits_protocol_pairing_metadata() {
    let device = RemoteDevice {
        id: DeviceId::new().to_string(),
        label: "phone".to_string(),
        fingerprint: "f".repeat(32),
        scopes: [RemoteScope::ReadProjectState].into_iter().collect(),
        paired_at: 1,
        last_seen_at: None,
        revoked_at: None,
        descriptor: None,
        session_id: Some(SessionId::new().to_string()),
    };
    let value = serde_json::to_value(RemoteDeviceView::from(&device)).expect("serialize view");
    assert!(value.get("descriptor").is_none());
    assert!(value.get("sessionId").is_none());
}

#[test]
fn audit_entries_are_metadata_only() {
    let (state, root) = temp_state("audit");
    let entry = RemoteAuditEntry {
        timestamp: 5,
        device_id: DeviceId::new().to_string(),
        request_id: "request-1".to_string(),
        action: "send_chat".to_string(),
        transport: "tcp_relay".to_string(),
        project_id: Some("project-a".to_string()),
        outcome: "allowed".to_string(),
        error_code: None,
    };
    append_audit(&state, &entry).expect("write audit");
    let raw = std::fs::read_to_string(&state.audit_path).expect("read audit");
    assert!(raw.contains("send_chat"));
    assert!(!raw.contains("do not persist this prompt"));
    assert_eq!(
        read_audit(&state.audit_path, 10)
            .expect("read entries")
            .len(),
        1
    );
    let _ = std::fs::remove_dir_all(root);
}

#[test]
fn encrypted_wire_session_binds_the_grant_to_the_route_sender() {
    let desktop = remote_protocol::DeviceId::new();
    let phone = remote_protocol::DeviceId::new();
    let incoming =
        remote_protocol::SessionRoute::new(remote_protocol::SessionId::new(), phone, desktop);
    let key = remote_protocol::SessionKey::from_bytes([9_u8; 32]);
    let session = RemoteWireSession::new(
        phone.to_string(),
        remote_protocol::TransportKind::P2p,
        key.clone(),
        incoming.clone(),
    )
    .expect("matching route identity should build a session");
    assert_eq!(session.outgoing_route, incoming.reversed());
    assert!(RemoteWireSession::new(
        "another-device".to_string(),
        remote_protocol::TransportKind::TcpRelay,
        key,
        incoming,
    )
    .is_err());
}
