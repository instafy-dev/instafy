use crate::error::ServiceError;

pub fn parse_repo_segment(path: &str) -> Result<(String, String), ServiceError> {
    let trimmed = path.trim_start_matches('/');
    let Some(first) = trimmed.split('/').next() else {
        return Err(ServiceError::not_found("missing repo path"));
    };
    if first.is_empty() || !first.ends_with(".git") {
        return Err(ServiceError::not_found("expected /<repo>.git/..."));
    }
    if first.contains('\\') || first.contains("..") {
        return Err(ServiceError::bad_request("invalid repo path"));
    }
    let repo_dir = first.to_string();
    let repo_name = first.trim_end_matches(".git").to_string();
    if repo_name.is_empty() || !is_safe_repo_name(&repo_name) {
        return Err(ServiceError::bad_request("invalid repo name"));
    }
    Ok((repo_dir, repo_name))
}

pub fn required_scope(path: &str, query: Option<&str>) -> &'static str {
    let lower_path = path.to_ascii_lowercase();
    if lower_path.contains("git-receive-pack") {
        return "git.write";
    }
    if let Some(query) = query {
        if query
            .to_ascii_lowercase()
            .contains("service=git-receive-pack")
        {
            return "git.write";
        }
    }
    "git.read"
}

pub fn pick_shard_index(repo_name: &str, shard_count: usize) -> usize {
    if shard_count <= 1 {
        return 0;
    }
    (fnv1a_64(repo_name.as_bytes()) % shard_count as u64) as usize
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x00000100000001B3);
    }
    hash
}

fn is_safe_repo_name(name: &str) -> bool {
    name.bytes().all(|b| match b {
        b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => true,
        _ => false,
    })
}
