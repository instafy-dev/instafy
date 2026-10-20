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

/// Shared middlewares every private router must carry; see `render_traefik_dynamic_config`.
pub const PREVIEW_AUTH_MIDDLEWARE: &str = "instafy-preview-auth";
pub const PREVIEW_HEADERS_MIDDLEWARE: &str = "instafy-preview-headers";
pub const PREVIEW_ERRORS_MIDDLEWARE: &str = "instafy-preview-errors";
/// The broker itself, serving `/preview-error/:status` pages for the errors middleware.
pub const PREVIEW_PAGES_SERVICE: &str = "instafy-preview-pages";

/// Public bindings get a plain `Host(<uuid>.<TUNNEL_DOMAIN>)` router. Private bindings get no
/// router on that host at all: only a capability `HostRegexp` on `PREVIEW_DOMAIN`, behind the
/// broker's forwardAuth. Without the preview config a private binding renders nothing.
pub fn render_traefik_dynamic_config(cfg: &BrokerConfig, bindings: &[RatholeBinding]) -> String {
    let routed: Vec<&RatholeBinding> = bindings
        .iter()
        .filter(|binding| !binding.is_private() || cfg.preview.is_some())
        .collect();
    if routed.is_empty() {
        return "{}\n".to_string();
    }
    let preview = cfg
        .preview
        .as_ref()
        .filter(|_| routed.iter().any(|binding| binding.is_private()));

    let tls_resolver = cfg.traefik_cert_resolver.as_deref();
    let mut out = String::new();
    out.push_str("http:\n");
    out.push_str("  routers:\n");
    for binding in &routed {
        let name = sanitize_traefik_name(&binding.rathole_service);
        out.push_str(&format!("    {name}:\n"));
        let tls_domain = match preview {
            Some(preview) if binding.is_private() => {
                out.push_str(&format!(
                    "      rule: \"HostRegexp(`^p-[a-z2-7]{{26}}--{}\\\\.{}$`)\"\n",
                    binding.tunnel_hex(),
                    escape_domain_regex(&preview.domain)
                ));
                &preview.domain
            }
            _ => {
                out.push_str(&format!("      rule: \"Host(`{}`)\"\n", binding.hostname));
                &cfg.tunnel_domain
            }
        };
        out.push_str(&format!("      service: \"{name}\"\n"));
        out.push_str("      entryPoints:\n");
        out.push_str("        - web\n");
        out.push_str("        - websecure\n");
        if binding.is_private() {
            out.push_str("      middlewares:\n");
            out.push_str(&format!("        - {PREVIEW_AUTH_MIDDLEWARE}\n"));
            out.push_str(&format!("        - {PREVIEW_HEADERS_MIDDLEWARE}\n"));
            out.push_str(&format!("        - {PREVIEW_ERRORS_MIDDLEWARE}\n"));
        }
        if let Some(resolver) = tls_resolver {
            out.push_str("      tls:\n");
            out.push_str(&format!("        certResolver: {resolver}\n"));
            out.push_str("        domains:\n");
            out.push_str(&format!("          - main: \"{tls_domain}\"\n"));
            out.push_str("            sans:\n");
            out.push_str(&format!("              - \"*.{tls_domain}\"\n"));
        }
    }

    if let Some(preview) = preview {
        out.push_str("  middlewares:\n");
        out.push_str(&format!("    {PREVIEW_AUTH_MIDDLEWARE}:\n"));
        out.push_str("      forwardAuth:\n");
        out.push_str(&format!(
            "        address: \"{}/preview-auth\"\n",
            preview.auth_address
        ));
        out.push_str("        trustForwardHeader: false\n");
        out.push_str(&format!("    {PREVIEW_HEADERS_MIDDLEWARE}:\n"));
        out.push_str("      headers:\n");
        out.push_str("        customResponseHeaders:\n");
        // An empty value strips the site's own header, so Studio can frame the preview.
        out.push_str("          X-Frame-Options: \"\"\n");
        out.push_str("          Referrer-Policy: \"no-referrer\"\n");
        out.push_str("          X-Robots-Tag: \"noindex\"\n");
        out.push_str(&format!("    {PREVIEW_ERRORS_MIDDLEWARE}:\n"));
        out.push_str("      errors:\n");
        out.push_str("        status:\n");
        out.push_str("          - \"502-504\"\n");
        out.push_str(&format!("        service: \"{PREVIEW_PAGES_SERVICE}\"\n"));
        out.push_str("        query: \"/preview-error/{status}\"\n");
    }

    out.push_str("  services:\n");
    for binding in &routed {
        let name = sanitize_traefik_name(&binding.rathole_service);
        out.push_str(&format!("    {name}:\n"));
        out.push_str("      loadBalancer:\n");
        out.push_str("        servers:\n");
        out.push_str(&format!(
            "          - url: \"http://rathole:{}\"\n",
            binding.rathole_port
        ));
    }
    if let Some(preview) = preview {
        out.push_str(&format!("    {PREVIEW_PAGES_SERVICE}:\n"));
        out.push_str("      loadBalancer:\n");
        out.push_str("        servers:\n");
        out.push_str(&format!("          - url: \"{}\"\n", preview.auth_address));
    }

    out
}

/// Config validation limits the domain to `[a-z0-9.-]`, so only the dots need escaping.
fn escape_domain_regex(domain: &str) -> String {
    domain.replace('.', "\\\\.")
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
    use crate::config::{HookConfig, PreviewConfig};
    use std::net::IpAddr;
    use uuid::Uuid;

    const PRIVATE_HEX: &str = "0123456789abcdef0123456789abcdef";

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
            preview: Some(PreviewConfig {
                domain: "preview.test".into(),
                auth_address: "http://broker:8080".into(),
            }),
            preview_auth_hook: None,
            preview_max_ttl_seconds: 43_200,
            rathole_upstream_host: "rathole".into(),
        }
    }

    fn binding(service: &str, port: i32, hostname: &str, visibility: &str) -> RatholeBinding {
        RatholeBinding {
            tunnel_id: Uuid::new_v4(),
            rathole_service: service.into(),
            rathole_port: port,
            token: "tok".into(),
            hostname: hostname.into(),
            visibility: visibility.into(),
            kind: "tunnel".into(),
        }
    }

    fn private_binding() -> RatholeBinding {
        RatholeBinding {
            tunnel_id: Uuid::parse_str(PRIVATE_HEX).unwrap(),
            kind: "preview".into(),
            ..binding("tunnel_def", 20002, "def.rt.test", "private")
        }
    }

    /// Splits the `routers:` map into `(name, block)` pairs without a YAML dependency.
    fn router_blocks(rendered: &str) -> Vec<(String, String)> {
        let Some(start) = rendered.find("  routers:\n") else {
            return Vec::new();
        };
        let mut blocks: Vec<(String, String)> = Vec::new();
        for line in rendered[start + "  routers:\n".len()..].lines() {
            if !line.starts_with("    ") {
                break;
            }
            if !line.starts_with("     ") {
                blocks.push((line.trim().trim_end_matches(':').to_string(), String::new()));
            } else if let Some((_, block)) = blocks.last_mut() {
                block.push_str(line);
                block.push('\n');
            }
        }
        blocks
    }

    #[test]
    fn rathole_config_renders_services() {
        let cfg = test_cfg();
        let bindings = vec![binding("tunnel_abc", 20001, "abc.rt.test", "public")];

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
        let bindings = vec![binding("tunnel_abc", 20000, "abc.rt.test", "public")];

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

    #[test]
    fn rathole_config_keeps_private_services() {
        let cfg = test_cfg();
        let rendered = render_rathole_server_config(&cfg, &[private_binding()]);
        assert!(rendered.contains("[server.services.tunnel_def]"));
        assert!(rendered.contains("bind_addr = \"0.0.0.0:20002\""));
    }

    #[test]
    fn traefik_config_routes_private_bindings_through_preview_auth() {
        let mut cfg = test_cfg();
        cfg.traefik_cert_resolver = None;
        let rendered = render_traefik_dynamic_config(&cfg, &[private_binding()]);
        let expected = concat!(
            "http:\n",
            "  routers:\n",
            "    tunnel_def:\n",
            "      rule: \"HostRegexp(`^p-[a-z2-7]{26}--0123456789abcdef0123456789abcdef\\\\.preview\\\\.test$`)\"\n",
            "      service: \"tunnel_def\"\n",
            "      entryPoints:\n",
            "        - web\n",
            "        - websecure\n",
            "      middlewares:\n",
            "        - instafy-preview-auth\n",
            "        - instafy-preview-headers\n",
            "        - instafy-preview-errors\n",
            "  middlewares:\n",
            "    instafy-preview-auth:\n",
            "      forwardAuth:\n",
            "        address: \"http://broker:8080/preview-auth\"\n",
            "        trustForwardHeader: false\n",
            "    instafy-preview-headers:\n",
            "      headers:\n",
            "        customResponseHeaders:\n",
            "          X-Frame-Options: \"\"\n",
            "          Referrer-Policy: \"no-referrer\"\n",
            "          X-Robots-Tag: \"noindex\"\n",
            "    instafy-preview-errors:\n",
            "      errors:\n",
            "        status:\n",
            "          - \"502-504\"\n",
            "        service: \"instafy-preview-pages\"\n",
            "        query: \"/preview-error/{status}\"\n",
            "  services:\n",
            "    tunnel_def:\n",
            "      loadBalancer:\n",
            "        servers:\n",
            "          - url: \"http://rathole:20002\"\n",
            "    instafy-preview-pages:\n",
            "      loadBalancer:\n",
            "        servers:\n",
            "          - url: \"http://broker:8080\"\n",
        );
        assert_eq!(rendered, expected);
        assert!(!rendered.contains("def.rt.test"));
        assert!(!rendered.contains("Host(`"));
    }

    #[test]
    fn traefik_config_uses_preview_domain_certificate_for_private_routers() {
        let cfg = test_cfg();
        let rendered = render_traefik_dynamic_config(
            &cfg,
            &[
                binding("tunnel_abc", 20000, "abc.rt.test", "public"),
                private_binding(),
            ],
        );
        let blocks = router_blocks(&rendered);
        let public = &blocks
            .iter()
            .find(|(name, _)| name == "tunnel_abc")
            .unwrap()
            .1;
        let private = &blocks
            .iter()
            .find(|(name, _)| name == "tunnel_def")
            .unwrap()
            .1;
        assert!(public.contains("- main: \"rt.test\""));
        assert!(!public.contains("middlewares"));
        assert!(private.contains("- main: \"preview.test\""));
        assert!(private.contains("- \"*.preview.test\""));
    }

    #[test]
    fn traefik_config_leaves_public_bindings_unchanged_beside_private_ones() {
        let cfg = test_cfg();
        let public_only = render_traefik_dynamic_config(
            &cfg,
            &[binding("tunnel_abc", 20000, "abc.rt.test", "public")],
        );
        let mixed = render_traefik_dynamic_config(
            &cfg,
            &[
                binding("tunnel_abc", 20000, "abc.rt.test", "public"),
                private_binding(),
            ],
        );
        let public_router = &router_blocks(&public_only)[0];
        assert!(router_blocks(&mixed).contains(public_router));
        assert!(!public_only.contains("instafy-preview"));
    }

    #[test]
    fn traefik_config_fails_closed_without_preview_domain() {
        let mut cfg = test_cfg();
        cfg.preview = None;
        assert_eq!(
            render_traefik_dynamic_config(&cfg, &[private_binding()]),
            "{}\n"
        );

        let rendered = render_traefik_dynamic_config(
            &cfg,
            &[
                binding("tunnel_abc", 20000, "abc.rt.test", "public"),
                private_binding(),
            ],
        );
        assert!(rendered.contains("tunnel_abc"));
        assert!(!rendered.contains("tunnel_def"));
        assert!(!rendered.contains("def.rt.test"));
        assert!(!rendered.contains("instafy-preview"));
        assert!(!rendered.contains("rathole:20002"));
    }

    #[test]
    fn every_private_router_has_preview_auth() {
        let cfg = test_cfg();
        let bindings = vec![
            binding("tunnel_pub", 20000, "pub.rt.test", "public"),
            binding("tunnel_priv", 20001, "priv.rt.test", "private"),
            // Unknown visibility values fail closed onto the private path.
            binding("tunnel_odd", 20003, "odd.rt.test", "members"),
            private_binding(),
        ];
        let rendered = render_traefik_dynamic_config(&cfg, &bindings);
        let blocks = router_blocks(&rendered);
        assert_eq!(blocks.len(), bindings.len());
        for binding in &bindings {
            let name = sanitize_traefik_name(&binding.rathole_service);
            let (_, block) = blocks.iter().find(|(router, _)| *router == name).unwrap();
            if binding.is_private() {
                assert!(
                    block.contains("HostRegexp(`^p-"),
                    "{name} must be a capability router"
                );
                assert!(
                    !rendered.contains(&binding.hostname),
                    "{name} leaks its tunnel host"
                );
            }
        }
        for (name, block) in &blocks {
            if block.contains("HostRegexp(") {
                assert!(
                    block.contains(&format!("- {PREVIEW_AUTH_MIDDLEWARE}\n")),
                    "{name} has no preview auth"
                );
            }
        }
    }
}
