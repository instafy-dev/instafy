use super::*;
use httpmock::prelude::*;

fn payload() -> PushNotificationPayload {
    PushNotificationPayload {
        event_id: Uuid::new_v4(),
        account_id: Uuid::new_v4(),
        title: "Instafy support".into(),
        body: "You have a new support reply.".into(),
        url: format!("/studio?supportReportId={}", Uuid::new_v4()),
    }
}

#[test]
fn notification_transport_rejects_unsafe_endpoint_urls() {
    for url in [
        "http://push.example.com/send",
        "file:///etc/passwd",
        "https://user:secret@push.example.com/send",
        "https://push.example.com:8443/send",
        "https://push.example.com/send#fragment",
        "https://127.0.0.1/send",
        "https://2130706433/send",
        "https://0x7f000001/send",
        "https://169.254.169.254/latest/meta-data",
        "https://10.0.0.1/send",
        "https://192.168.1.1/send",
        "https://172.16.0.1/send",
        "https://100.64.0.1/send",
        "https://[::1]/send",
        "https://[::ffff:127.0.0.1]/send",
        "https://[fc00::1]/send",
        "https://[fe80::1]/send",
        "https://localhost/send",
        "https://metadata.google.internal/send",
        "https://push.local/send",
        "https://push.example.com./send",
        "https://push.example.com\\@127.0.0.1/send",
    ] {
        assert!(parse_web_push_endpoint(url).is_err(), "must reject {url}");
    }
    assert!(parse_web_push_endpoint("https://push.example.com/send/opaque-token").is_ok());
    assert!(
        parse_web_push_endpoint(&format!("https://push.example.com/{}", "x".repeat(2048))).is_err()
    );
}

#[test]
fn notification_transport_rejects_nonpublic_and_mixed_dns_answers() {
    for address in [
        "0.0.0.0",
        "198.18.0.1",
        "192.0.2.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "64:ff9b::a00:1",
        "2001:db8::1",
        "2002:7f00:1::",
        "3fff::1",
    ] {
        assert!(
            !is_public_push_address(address.parse().unwrap()),
            "must reject {address}"
        );
    }
    let public: SocketAddr = "1.1.1.1:443".parse().unwrap();
    let private: SocketAddr = "127.0.0.1:443".parse().unwrap();
    assert!(validate_resolved_addresses(&[public]).is_ok());
    assert!(validate_resolved_addresses(&[public, private]).is_err());
    assert!(validate_resolved_addresses(&[]).is_err());
    let url = parse_web_push_endpoint("https://push.example.com/send").unwrap();
    assert!(secure_push_client(&url, &[public, private]).is_err());
    assert!(is_public_push_address(
        "2606:4700:4700::1111".parse().unwrap()
    ));
}

#[test]
fn notification_transport_payload_is_account_scoped_and_has_canonical_links() {
    let mut message = payload();
    assert!(validate_push_payload(&message, message.account_id));
    assert!(!validate_push_payload(&message, Uuid::new_v4()));
    for url in [
        "https://evil.example/",
        "//evil.example/",
        "/studio?token=secret",
        "/studio?projectId=not-a-uuid",
        "/studio?",
        "/studio?projectId=00000000-0000-0000-0000-000000000001#evil",
    ] {
        message.url = url.into();
        assert!(!validate_push_payload(&message, message.account_id));
    }
    message = payload();
    message.url = format!(
        "/studio?supportReportId={}&projectId={}",
        Uuid::new_v4(),
        Uuid::new_v4()
    );
    assert!(!validate_push_payload(&message, message.account_id));
    message.url = format!("/studio?conversationControllerId={}", Uuid::new_v4());
    assert!(!validate_push_payload(&message, message.account_id));
    message = payload();
    message.body = "x".repeat(513);
    assert!(!validate_push_payload(&message, message.account_id));
    let encoded = serde_json::to_value(payload()).unwrap();
    let fields = encoded.as_object().unwrap();
    assert_eq!(fields.len(), 5);
    assert!(fields.contains_key("eventId"));
    assert!(fields.contains_key("accountId"));
}

#[test]
fn notification_transport_validates_native_platform_token_and_environment() {
    assert_eq!(normalize_native_platform(None), Ok("ios"));
    assert_eq!(normalize_native_platform(Some("android")), Ok("android"));
    assert!(normalize_native_platform(Some("windows")).is_err());
    assert_eq!(normalize_native_environment(None, true), Ok("sandbox"));
    assert_eq!(
        normalize_native_environment(Some("production"), true),
        Ok("production")
    );
    assert!(normalize_native_environment(Some("other"), false).is_err());
    assert!(validate_native_token(&"a1".repeat(32), "ios").is_ok());
    assert!(validate_native_token("../device/other", "ios").is_err());
    assert!(validate_native_token(&"a".repeat(514), "ios").is_err());
    assert!(validate_native_token("old-fcm-token:cleanup", "android").is_ok());
}

#[test]
fn notification_transport_web_push_matches_rfc8291_encryption_vector() {
    // Published RFC 8291 section 5 test material; these are deliberately public test keys.
    let client_public = BASE64URL
        .decode(concat!(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx",
            "aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"
        ))
        .unwrap();
    let client_auth = BASE64URL.decode("BTBZMqHH6r4Tts7J_aSIgg").unwrap();
    let sender_private = p256::SecretKey::from_slice(
        &BASE64URL
            .decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
            .unwrap(),
    )
    .unwrap();
    let sender_public = sender_private.public_key().to_encoded_point(false);
    let client_key = PublicKey::from_sec1_bytes(&client_public).unwrap();
    let shared =
        p256::ecdh::diffie_hellman(sender_private.to_nonzero_scalar(), client_key.as_affine());
    let expected = BASE64URL
        .decode(concat!(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml",
            "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT",
            "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        ))
        .unwrap();
    let salt: [u8; 16] = expected[..16].try_into().unwrap();
    let encrypted = encrypt_web_push_record(
        &client_public,
        &client_auth,
        shared.raw_secret_bytes().as_ref(),
        sender_public.as_bytes(),
        &salt,
        b"When I grow up, I want to be a watermelon",
    )
    .unwrap();
    assert_eq!(encrypted, expected);
    let key = BASE64URL.encode(&client_public);
    let auth = BASE64URL.encode(&client_auth);
    assert!(validate_web_push_keys(&key, &auth).is_ok());
    assert!(encrypt_web_push_payload("invalid", &auth, b"safe payload").is_err());
    assert!(encrypt_web_push_payload(&key, &auth, &vec![0; MAX_PUSH_PAYLOAD_BYTES + 1]).is_err());
    let first = encrypt_web_push_payload(&key, &auth, b"safe payload").unwrap();
    let second = encrypt_web_push_payload(&key, &auth, b"safe payload").unwrap();
    assert_ne!(
        first, second,
        "each encryption has fresh salt and ephemeral key"
    );
}

#[test]
fn notification_transport_provider_statuses_are_bounded_and_actionable() {
    use DeliveryDisposition::*;
    for channel in ["web_push", "apns"] {
        for status in [200, 201, 204] {
            assert_eq!(
                provider_response_result(channel, status, None).disposition,
                Success
            );
        }
        for status in [408, 425, 429, 500, 503] {
            assert_eq!(
                provider_response_result(channel, status, None).disposition,
                Transient
            );
        }
        for status in [301, 307, 400, 401, 403, 413] {
            assert_eq!(
                provider_response_result(channel, status, None).disposition,
                Terminal
            );
        }
        assert_eq!(
            provider_response_result(channel, 410, None).disposition,
            Expired
        );
    }
    assert_eq!(
        provider_response_result("apns", 404, None).disposition,
        Terminal
    );
    assert_eq!(
        provider_response_result("web_push", 404, None).disposition,
        Expired
    );
    assert_eq!(
        provider_response_result("apns", 400, Some("BadDeviceToken")).disposition,
        Expired
    );
    assert_eq!(
        provider_response_result("apns", 400, Some("DeviceTokenNotForTopic")).disposition,
        Terminal
    );
}

#[tokio::test]
async fn notification_transport_mock_web_push_contract_and_redirect_refusal() {
    let server = MockServer::start_async().await;
    let message = payload();
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let accepted = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/push")
                .header("ttl", "3600")
                .header("topic", message.event_id.simple().to_string())
                .header("authorization", "vapid t=test-jwt, k=test-public")
                .header("content-encoding", "aes128gcm")
                .header("content-type", "application/octet-stream")
                .body("encrypted-body");
            then.status(201);
        })
        .await;
    let result = execute_push_request(
        web_push_request(
            &client,
            &reqwest::Url::parse(&server.url("/push")).unwrap(),
            "test-jwt",
            "test-public",
            b"encrypted-body".to_vec(),
            message.event_id,
        ),
        "web_push",
    )
    .await;
    assert_eq!(result.disposition, DeliveryDisposition::Success);
    accepted.assert_async().await;
    let destination = server
        .mock_async(|when, then| {
            when.path("/private");
            then.status(201);
        })
        .await;
    let redirect = server
        .mock_async(|when, then| {
            when.path("/redirect");
            then.status(307).header("Location", server.url("/private"));
        })
        .await;
    let result = execute_push_request(client.post(server.url("/redirect")), "web_push").await;
    assert_eq!(result.disposition, DeliveryDisposition::Terminal);
    redirect.assert_async().await;
    assert_eq!(destination.hits_async().await, 0);
}

#[tokio::test]
async fn notification_transport_mock_apns_contract_and_error_body_limits() {
    let server = MockServer::start_async().await;
    let message = payload();
    let client = reqwest::Client::builder().no_proxy().build().unwrap();
    let accepted = server.mock_async(|when, then| {
        when.method(POST).path("/3/device/test-token")
            .header("authorization", "bearer test-jwt")
            .header("apns-topic", "dev.instafy.test")
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .header("apns-id", message.event_id.to_string())
            .header("apns-collapse-id", message.event_id.to_string())
            .json_body(json!({"aps":{"alert":{"title":message.title,"body":message.body}},"eventId":message.event_id,"accountId":message.account_id,"url":message.url}));
        then.status(200);
    }).await;
    let result = execute_push_request(
        apns_request(
            &client,
            &reqwest::Url::parse(&server.url("/3/device/test-token")).unwrap(),
            "test-jwt",
            "dev.instafy.test",
            &message,
        ),
        "apns",
    )
    .await;
    assert_eq!(result.disposition, DeliveryDisposition::Success);
    accepted.assert_async().await;
    for (path, status, body, disposition) in [
        (
            "/expired",
            410,
            json!({"reason":"Unregistered"}).to_string(),
            DeliveryDisposition::Expired,
        ),
        (
            "/bad-token",
            400,
            json!({"reason":"BadDeviceToken"}).to_string(),
            DeliveryDisposition::Expired,
        ),
        (
            "/retry",
            429,
            json!({"reason":"TooManyRequests"}).to_string(),
            DeliveryDisposition::Transient,
        ),
        (
            "/huge-body",
            400,
            format!(
                "{{\"reason\":\"BadDeviceToken\",\"other\":\"{}\"}}",
                "x".repeat(2048)
            ),
            DeliveryDisposition::Terminal,
        ),
    ] {
        let mock = server
            .mock_async(|when, then| {
                when.path(path);
                then.status(status).body(body);
            })
            .await;
        let result = execute_push_request(client.post(server.url(path)), "apns").await;
        assert_eq!(result.disposition, disposition);
        mock.assert_async().await;
    }
}

#[tokio::test]
async fn notification_transport_db_final_preflight_rechecks_changes_during_preparation(
) -> anyhow::Result<()> {
    use crate::tests::{
        build_app_config, build_test_state, ensure_test_user, require_origin_test_pool,
        test_origin_private_key, test_origin_public_key,
    };
    let pool = require_origin_test_pool("notification transport preflight").await?;
    let owner = Uuid::new_v4();
    let outsider = Uuid::new_v4();
    ensure_test_user(&pool, &owner).await?;
    ensure_test_user(&pool, &outsider).await?;
    let report = Uuid::new_v4();
    let endpoint = Uuid::new_v4();
    let event;
    let mut lease_token = Uuid::new_v4();
    let mut updated;
    {
        let db = pool.get().await?;
        db.execute("insert into web_push_subscriptions(id,user_id,endpoint,p256dh,auth) values($1,$2,$3,'test','test')", &[&endpoint,&owner,&format!("https://push.example.com/{endpoint}")]).await?;
        updated = db
            .query_one(
                "select updated_at from web_push_subscriptions where id=$1",
                &[&endpoint],
            )
            .await?
            .get(0);
        db.execute("insert into bug_reports(id,user_id,message,status) values($1,$2,'private preflight fixture','open')", &[&report,&owner]).await?;
        db.execute("insert into bug_report_messages(id,bug_report_id,author_type,body) values($1,$2,'support','private support response')", &[&Uuid::new_v4(),&report]).await?;
        event = db.query_one("select id from notification_events where resource_id=$1 and event_name='support.reply'", &[&report]).await?.get(0);
        db.execute("update notification_delivery_jobs set status='leased',lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds',attempt_count=1 where event_id=$1", &[&event,&lease_token]).await?;
    }
    let state = build_test_state(
        pool.clone(),
        build_app_config(
            test_origin_private_key(),
            test_origin_public_key(),
            "transport-preflight-test",
        ),
    );
    let mut message = PushNotificationPayload {
        event_id: event,
        account_id: owner,
        title: "Instafy".into(),
        body: "You have a new notification.".into(),
        url: format!("/studio?supportReportId={report}"),
    };
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_ok());
    // A reclaimed job has an unexpired lease, but that must not authorize the
    // previous worker's prepared request. Only this exact attempt's token works.
    let stale_lease_token = lease_token;
    lease_token = Uuid::new_v4();
    pool.get().await?.execute(
        "update notification_delivery_jobs set lease_token=$2,lease_until=clock_timestamp()+interval '90 seconds' where event_id=$1",
        &[&event,&lease_token],
    ).await?;
    assert_eq!(
        revalidate_delivery_endpoint(
            &state,
            "web_push",
            endpoint,
            stale_lease_token,
            &message,
            updated
        )
        .await
        .unwrap_err()
        .code,
        "delivery_eligibility_changed"
    );
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_ok());
    // These changes occur after endpoint/DNS preparation but before final send.
    {
        let db = pool.get().await?;
        db.execute(
            "update web_push_subscriptions set p256dh='new registration' where id=$1",
            &[&endpoint],
        )
        .await?;
    }
    assert_eq!(
        revalidate_delivery_endpoint(&state, "web_push", endpoint, lease_token, &message, updated)
            .await
            .unwrap_err()
            .code,
        "delivery_eligibility_changed"
    );
    updated = pool
        .get()
        .await?
        .query_one(
            "select updated_at from web_push_subscriptions where id=$1",
            &[&endpoint],
        )
        .await?
        .get(0);
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_ok());
    pool.get()
        .await?
        .execute(
            "update web_push_subscriptions set user_id=$2 where id=$1",
            &[&endpoint, &outsider],
        )
        .await?;
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_err());
    pool.get()
        .await?
        .execute(
            "update web_push_subscriptions set user_id=$2 where id=$1",
            &[&endpoint, &owner],
        )
        .await?;
    updated = pool
        .get()
        .await?
        .query_one(
            "select updated_at from web_push_subscriptions where id=$1",
            &[&endpoint],
        )
        .await?
        .get(0);
    pool.get().await?.execute("insert into notification_preferences(user_id,category,channel,enabled) values($1,'support','web_push',false)", &[&owner]).await?;
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_err());
    pool.get()
        .await?
        .execute(
            "update notification_preferences set enabled=true where user_id=$1",
            &[&owner],
        )
        .await?;
    message.title = "Support replied".into();
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_err());
    pool.get()
        .await?
        .execute(
            "insert into notification_settings(user_id,hide_previews) values($1,false)",
            &[&owner],
        )
        .await?;
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_ok());
    pool.get()
        .await?
        .execute(
            "update notification_settings set hide_previews=true where user_id=$1",
            &[&owner],
        )
        .await?;
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_err());
    message.title = "Instafy".into();
    pool.get()
        .await?
        .execute(
            "update bug_reports set user_id=$2 where id=$1",
            &[&report, &outsider],
        )
        .await?;
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_err());
    pool.get()
        .await?
        .execute(
            "update bug_reports set user_id=$2 where id=$1",
            &[&report, &owner],
        )
        .await?;
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_ok());
    pool.get()
        .await?
        .execute(
            "update notification_recipients set read_at=clock_timestamp() where event_id=$1",
            &[&event],
        )
        .await?;
    assert!(revalidate_delivery_endpoint(
        &state,
        "web_push",
        endpoint,
        lease_token,
        &message,
        updated
    )
    .await
    .is_err());
    let db = pool.get().await?;
    db.execute("delete from notification_events where id=$1", &[&event])
        .await?;
    db.execute("delete from bug_reports where id=$1", &[&report])
        .await?;
    db.execute(
        "delete from auth.users where id=any($1)",
        &[&vec![owner, outsider]],
    )
    .await?;
    Ok(())
}

#[tokio::test]
async fn notification_transport_db_registration_capacity_allows_refresh_and_serializes_new_devices(
) -> anyhow::Result<()> {
    use crate::tests::{ensure_test_user, require_origin_test_pool};
    let pool = require_origin_test_pool("notification transport registration capacity").await?;
    let owner = Uuid::new_v4();
    ensure_test_user(&pool, &owner).await?;
    {
        let db = pool.get().await?;
        for index in 0..31 {
            db.execute("insert into web_push_subscriptions(user_id,endpoint,p256dh,auth) values($1,$2,'test','test')", &[&owner,&format!("https://push.example.com/{owner}/{index}")]).await?;
        }
    }
    let insert_device = |number: usize| {
        let pool = pool.clone();
        async move {
            let mut db = pool.get().await?;
            let transaction = db.transaction().await?;
            let endpoint = format!("https://push.example.com/{owner}/concurrent-{number}");
            let allowed = check_registration_capacity(&transaction, owner, "web_push", &endpoint)
                .await
                .is_ok();
            if allowed {
                transaction.execute("insert into web_push_subscriptions(user_id,endpoint,p256dh,auth) values($1,$2,'test','test')", &[&owner,&endpoint]).await?;
            }
            transaction.commit().await?;
            Ok::<bool, anyhow::Error>(allowed)
        }
    };
    let (first, second) = tokio::join!(insert_device(1), insert_device(2));
    assert_ne!(
        first?, second?,
        "only one concurrent registration can take the final slot"
    );
    {
        let mut db = pool.get().await?;
        let transaction = db.transaction().await?;
        assert!(check_registration_capacity(
            &transaction,
            owner,
            "web_push",
            &format!("https://push.example.com/{owner}/0")
        )
        .await
        .is_ok());
        assert!(check_registration_capacity(
            &transaction,
            owner,
            "web_push",
            "https://push.example.com/new-device"
        )
        .await
        .is_err());
        transaction.commit().await?;
    }
    let db = pool.get().await?;
    assert_eq!(
        db.query_one(
            "select count(*) from web_push_subscriptions where user_id=$1",
            &[&owner]
        )
        .await?
        .get::<_, i64>(0),
        32
    );
    db.execute("delete from auth.users where id=$1", &[&owner])
        .await?;
    Ok(())
}
