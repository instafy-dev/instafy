use crate::config::BrokerConfig;
use crate::db::RatholeBinding;

pub fn render_rathole_server_config(cfg: &BrokerConfig, bindings: &[RatholeBinding]) -> String {
    let mut out = String::new();
    out.push_str("[server]\n");
    out.push_str(&format!("bind_addr = \"0.0.0.0:{}\"\n", cfg.ingress_port));
    if let Some(token) = cfg.rathole_shared_token.as_ref() {
        out.push_str(&format!("default_token = \"{}\"\n", token));
    }
    out.push_str("heartbeat_interval = 30\n");
    out.push('\n');
    out.push_str("[server.transport]\n");
    out.push_str("type = \"tcp\"\n\n");
    out.push_str("[server.transport.tcp]\n");
    out.push_str("nodelay = true\n");
    out.push_str("keepalive_secs = 20\n");
    out.push_str("keepalive_interval = 8\n\n");
    out.push_str("[server.services]\n\n");

    for binding in bindings {
        out.push_str(&format!("[server.services.{}]\n", binding.rathole_service));
        out.push_str(&format!(
            "bind_addr = \"0.0.0.0:{}\"\n",
            binding.rathole_port
        ));
        out.push_str(&format!("token = \"{}\"\n", binding.token));
        out.push_str("type = \"tcp\"\n\n");
    }

    out
}

pub fn render_traefik_dynamic_config(cfg: &BrokerConfig, bindings: &[RatholeBinding]) -> String {
    if bindings.is_empty() {
        return "{}\n".to_string();
    }

    let tls_enabled = cfg.traefik_cert_resolver.as_deref().is_some();
    let mut out = String::new();
    out.push_str("http:\n");
    out.push_str("  routers:\n");
    for binding in bindings {
        let name = sanitize_traefik_name(&binding.rathole_service);
        out.push_str(&format!("    {name}:\n"));
        out.push_str(&format!("      rule: \"Host(`{}`)\"\n", binding.hostname));
        out.push_str(&format!("      service: \"{name}\"\n"));
        out.push_str("      entryPoints:\n");
        out.push_str("        - web\n");
        out.push_str("        - websecure\n");
        if tls_enabled {
            if let Some(resolver) = cfg.traefik_cert_resolver.as_deref() {
                out.push_str("      tls:\n");
                out.push_str(&format!("        certResolver: {resolver}\n"));
                out.push_str("        domains:\n");
                out.push_str(&format!("          - main: \"{}\"\n", cfg.tunnel_domain));
                out.push_str("            sans:\n");
                out.push_str(&format!("              - \"*.{}\"\n", cfg.tunnel_domain));
            }
        }
    }

    out.push_str("  services:\n");
    for binding in bindings {
        let name = sanitize_traefik_name(&binding.rathole_service);
        out.push_str(&format!("    {name}:\n"));
        out.push_str("      loadBalancer:\n");
        out.push_str("        servers:\n");
        out.push_str(&format!(
            "          - url: \"http://rathole:{}\"\n",
            binding.rathole_port
        ));
    }

    out
}

fn sanitize_traefik_name(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::HookConfig;
    use std::net::IpAddr;

    fn test_cfg() -> BrokerConfig {
        BrokerConfig {
            database_url: "postgres://localhost/test".into(),
            database_pool_size: 4,
            rathole_config_notify_channel: "tunnel_config_refresh".into(),
            http_bind: "127.0.0.1:8080".into(),
            tunnel_domain: "rt.test".into(),
            ingress_host: "ingress.rt.test".into(),
            ingress_port: 7000,
            public_ingress_port: 443,
            ingress_ipv4: Some(IpAddr::from([127, 0, 0, 1])),
            ingress_ipv6: None,
            rathole_shared_token: Some("shared".into()),
            rathole_port_range_start: 20000,
            rathole_port_range_end: 40000,
            default_ttl_seconds: 60,
            token_signing_key: "secret".into(),
            api_tokens: vec![],
            token_issuer: "issuer".into(),
            token_audience: None,
            token_ttl_seconds: 900,
            traefik_cert_resolver: Some("le".into()),
            acl_hook: Some(HookConfig {
                url: "http://example.com".into(),
                token: None,
            }),
            event_hook: None,
        }
    }

    #[test]
    fn rathole_config_renders_services() {
        let cfg = test_cfg();
        let bindings = vec![RatholeBinding {
            rathole_service: "tunnel_abc".into(),
            rathole_port: 20001,
            token: "tok".into(),
            hostname: "abc.rt.test".into(),
        }];

        let rendered = render_rathole_server_config(&cfg, &bindings);
        assert!(rendered.contains("default_token = \"shared\""));
        assert!(rendered.contains("[server.services]"));
        assert!(rendered.contains("[server.services.tunnel_abc]"));
        assert!(rendered.contains("bind_addr = \"0.0.0.0:20001\""));
    }

    #[test]
    fn rathole_config_renders_empty_services_table() {
        let cfg = test_cfg();
        let rendered = render_rathole_server_config(&cfg, &[]);
        assert!(rendered.contains("[server]"));
        assert!(rendered.contains("[server.services]"));
    }

    #[test]
    fn traefik_config_renders_host_rules() {
        let cfg = test_cfg();
        let bindings = vec![RatholeBinding {
            rathole_service: "tunnel_abc".into(),
            rathole_port: 20000,
            token: "tok".into(),
            hostname: "abc.rt.test".into(),
        }];

        let rendered = render_traefik_dynamic_config(&cfg, &bindings);
        let expected = "http:\n  routers:\n    tunnel_abc:\n      rule: \"Host(`abc.rt.test`)\"\n      service: \"tunnel_abc\"\n      entryPoints:\n        - web\n        - websecure\n      tls:\n        certResolver: le\n        domains:\n          - main: \"rt.test\"\n            sans:\n              - \"*.rt.test\"\n  services:\n    tunnel_abc:\n      loadBalancer:\n        servers:\n          - url: \"http://rathole:20000\"\n";
        assert_eq!(rendered, expected);
    }

    #[test]
    fn traefik_config_renders_empty_maps() {
        let cfg = test_cfg();
        let rendered = render_traefik_dynamic_config(&cfg, &[]);
        assert_eq!(rendered, "{}\n");
    }
}
