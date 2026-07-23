use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, anyhow, bail};
use reqwest::Url;
use serde::Deserialize;
use serde_json::json;

use super::{JobExecution, JobMessage, learn};

const SKILL_FILENAME: &str = "SKILL.md";
const INSTAFY_COMPAT_MARKER: &str = "<!-- instafy-compat -->";
const MAX_IMPORTED_SKILL_FILES: usize = 256;
const MAX_IMPORTED_SKILL_TOTAL_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillsRequest {
    List,
    Import(SkillImportRequest),
    Help { reason: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillImportRequest {
    pub source: String,
    pub skill_name: Option<String>,
    pub overwrite: bool,
}

#[derive(Debug)]
struct ImportedSkill {
    name: String,
    relative_path: String,
    source: String,
    changed: bool,
    files_written: usize,
    compatibility: CompatibilityReport,
}

#[derive(Debug, Clone, Default)]
struct SkillSourceData {
    files: Vec<SkillSourceFile>,
    resolved_source: String,
    source_name_hint: Option<String>,
}

#[derive(Debug, Clone)]
struct SkillSourceFile {
    relative_path: String,
    bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
enum SkillSourceFlavor {
    #[default]
    Generic,
    Claude,
}

impl SkillSourceFlavor {
    fn as_str(self) -> &'static str {
        match self {
            SkillSourceFlavor::Generic => "generic",
            SkillSourceFlavor::Claude => "claude",
        }
    }
}

#[derive(Debug, Clone, Default)]
struct CompatibilityReport {
    flavor: SkillSourceFlavor,
    rewrites: Vec<String>,
    warnings: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum GitHubSkillSourceKind {
    Tree,
    Blob,
    Raw,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitHubSkillSource {
    owner: String,
    repo: String,
    branch: String,
    skill_file_path: String,
    skill_directory_path: String,
    kind: GitHubSkillSourceKind,
}

#[derive(Debug, Deserialize)]
struct GitHubContentEntry {
    #[serde(rename = "type")]
    entry_type: String,
    path: String,
    download_url: Option<String>,
}

pub fn parse_skills_request(prompt_text: &str) -> Option<SkillsRequest> {
    let trimmed = prompt_text.trim();
    if trimmed.is_empty() {
        return None;
    }

    // Allow callers (like SkillsPanel) to include additional context after a
    // `/skills ...` command. The command is always parsed from the first line.
    let first_line = trimmed.lines().next().unwrap_or(trimmed).trim();
    if first_line.is_empty() {
        return None;
    }

    let lowered = first_line.to_ascii_lowercase();
    let command = if lowered.starts_with("/skills") {
        "/skills"
    } else if lowered.starts_with("/skill") {
        "/skill"
    } else {
        return None;
    };

    let rest = first_line.strip_prefix(command).unwrap_or("").trim();
    if rest.is_empty() {
        return Some(SkillsRequest::List);
    }

    let mut tokens = rest.split_whitespace();
    let Some(subcommand_raw) = tokens.next() else {
        return Some(SkillsRequest::List);
    };
    let subcommand = subcommand_raw.to_ascii_lowercase();

    match subcommand.as_str() {
        "list" => Some(SkillsRequest::List),
        "import" => Some(parse_skill_import_request(tokens.collect())),
        "help" => Some(SkillsRequest::Help { reason: None }),
        _ => Some(SkillsRequest::Help {
            reason: Some(format!("Unsupported skills subcommand `{subcommand_raw}`.")),
        }),
    }
}

fn parse_skill_import_request(tokens: Vec<&str>) -> SkillsRequest {
    if tokens.is_empty() {
        return SkillsRequest::Help {
            reason: Some("`/skills import` requires a source path or URL.".to_string()),
        };
    }

    let source = tokens[0].trim();
    if source.is_empty() {
        return SkillsRequest::Help {
            reason: Some("`/skills import` requires a source path or URL.".to_string()),
        };
    }

    let mut skill_name: Option<String> = None;
    let mut overwrite = false;

    let mut index = 1;
    while index < tokens.len() {
        let token = tokens[index].trim();
        if token.is_empty() {
            index += 1;
            continue;
        }

        if token.eq_ignore_ascii_case("as") || token.eq_ignore_ascii_case("--name") {
            if index + 1 >= tokens.len() {
                return SkillsRequest::Help {
                    reason: Some(format!("Missing value after `{token}`.")),
                };
            }
            skill_name = Some(tokens[index + 1].trim().to_string());
            index += 2;
            continue;
        }

        if token.eq_ignore_ascii_case("--overwrite") {
            overwrite = true;
            index += 1;
            continue;
        }

        return SkillsRequest::Help {
            reason: Some(format!(
                "Unsupported option `{token}` for `/skills import`."
            )),
        };
    }

    SkillsRequest::Import(SkillImportRequest {
        source: source.to_string(),
        skill_name,
        overwrite,
    })
}

pub async fn build_skills_execution(request: SkillsRequest, workspace_dir: &Path) -> JobExecution {
    match request {
        SkillsRequest::List => build_list_execution(workspace_dir),
        SkillsRequest::Help { reason } => build_help_execution(reason),
        SkillsRequest::Import(request) => match import_skill(workspace_dir, &request).await {
            Ok(imported) => {
                let change_type = if imported.changed {
                    "changed"
                } else {
                    "created"
                };
                let mut final_message = format!(
                    "Imported `{}` from {}. Use `/skills list` to confirm installed skills.",
                    imported.relative_path, imported.source
                );
                if imported.files_written > 1 {
                    final_message.push_str(&format!(
                        "\nImported {} files for this skill bundle.",
                        imported.files_written
                    ));
                }
                if !imported.compatibility.rewrites.is_empty()
                    || !imported.compatibility.warnings.is_empty()
                {
                    final_message.push_str("\n\nCompatibility report:");
                    final_message.push_str(&format!(
                        "\n- Source flavor: {}",
                        imported.compatibility.flavor.as_str()
                    ));
                    for rewrite in &imported.compatibility.rewrites {
                        final_message.push_str(&format!("\n- Rewrote: {rewrite}"));
                    }
                    for warning in &imported.compatibility.warnings {
                        final_message.push_str(&format!("\n- Warning: {warning}"));
                    }
                }
                JobExecution {
                    summary: format!(
                        "Imported skill `{}` to `{}`.",
                        imported.name, imported.relative_path
                    ),
                    suggested_replies: vec![
                        "List skills".to_string(),
                        "Run /learn to fold this into workspace memory".to_string(),
                    ],
                    provider: "skills".to_string(),
                    artifacts: vec![json!({
                        "kind": "skills/import",
                        "name": imported.name,
                        "source": imported.source,
                        "path": imported.relative_path,
                        "filesWritten": imported.files_written,
                        "compatibility": {
                            "flavor": imported.compatibility.flavor.as_str(),
                            "rewrites": imported.compatibility.rewrites,
                            "warnings": imported.compatibility.warnings,
                        },
                        "change": {
                            "type": change_type
                        }
                    })],
                    credit_snapshot: None,
                    provider_conversation_state: None,
                    messages: Vec::new(),
                    messages_streamed: false,
                    final_messages: vec![JobMessage {
                        content: final_message,
                        message_type: None,
                        metadata: None,
                    }],
                }
            }
            Err(error) => JobExecution {
                summary: format!("Skill import failed: {}", error),
                suggested_replies: Vec::new(),
                provider: "skills".to_string(),
                artifacts: Vec::new(),
                credit_snapshot: None,
                provider_conversation_state: None,
                messages: Vec::new(),
                messages_streamed: false,
                final_messages: vec![JobMessage {
                    content: format!("Skill import failed: {}\n\n{}", error, usage_text()),
                    message_type: Some("error".to_string()),
                    metadata: Some(json!({ "messageType": "error" })),
                }],
            },
        },
    }
}

fn build_list_execution(workspace_dir: &Path) -> JobExecution {
    let skills = list_installed_skills(workspace_dir);
    if skills.is_empty() {
        return JobExecution {
            summary: "No skills installed under `.agents/skills` yet.".to_string(),
            suggested_replies: vec!["Import a skill from GitHub".to_string()],
            provider: "skills".to_string(),
            artifacts: Vec::new(),
            credit_snapshot: None,
            provider_conversation_state: None,
            messages: Vec::new(),
            messages_streamed: false,
            final_messages: vec![JobMessage {
                content: format!("No skills found in `.agents/skills`.\n\n{}", usage_text()),
                message_type: None,
                metadata: None,
            }],
        };
    }

    let mut content = format!("Installed skills ({})\n", skills.len());
    for (name, path) in &skills {
        content.push_str(&format!("- {} ({})\n", name, path));
    }

    JobExecution {
        summary: format!("{} skill(s) available in `.agents/skills`.", skills.len()),
        suggested_replies: Vec::new(),
        provider: "skills".to_string(),
        artifacts: Vec::new(),
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: false,
        final_messages: vec![JobMessage {
            content,
            message_type: None,
            metadata: None,
        }],
    }
}

fn build_help_execution(reason: Option<String>) -> JobExecution {
    let mut content = String::new();
    if let Some(value) = reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        content.push_str(value);
        content.push_str("\n\n");
    }
    content.push_str(usage_text());

    JobExecution {
        summary: "Skills command help".to_string(),
        suggested_replies: Vec::new(),
        provider: "skills".to_string(),
        artifacts: Vec::new(),
        credit_snapshot: None,
        provider_conversation_state: None,
        messages: Vec::new(),
        messages_streamed: false,
        final_messages: vec![JobMessage {
            content,
            message_type: Some("error".to_string()),
            metadata: Some(json!({ "messageType": "error" })),
        }],
    }
}

async fn import_skill(workspace_dir: &Path, request: &SkillImportRequest) -> Result<ImportedSkill> {
    let source = request.source.trim();
    if source.is_empty() {
        bail!("source cannot be empty");
    }

    let mut source_data = read_skill_source(workspace_dir, source).await?;
    if source_data.files.is_empty() {
        bail!("source returned no files");
    }

    let primary_skill_index = locate_primary_skill_file_index(&source_data.files)
        .ok_or_else(|| anyhow!("source did not include {SKILL_FILENAME}"))?;
    let skill_markdown = String::from_utf8(source_data.files[primary_skill_index].bytes.clone())
        .context("SKILL.md must be UTF-8 text")?;
    let normalized_markdown = normalize_markdown_content(skill_markdown.as_str());
    if normalized_markdown.trim().is_empty() {
        bail!("source returned an empty skill file");
    }
    let (adapted_markdown, compatibility) = adapt_skill_markdown_for_instafy(
        normalized_markdown.as_str(),
        source_data.resolved_source.as_str(),
    );

    let explicit_name = request
        .skill_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_string());
    let frontmatter_name = extract_frontmatter_name(adapted_markdown.as_str());

    let chosen_name = explicit_name
        .or(frontmatter_name)
        .or(source_data.source_name_hint.clone())
        .ok_or_else(|| anyhow!("unable to derive a skill name; pass `--name <skill-name>`"))?;

    let normalized_name = normalize_skill_name(chosen_name.as_str())
        .ok_or_else(|| anyhow!("invalid skill name `{}`", chosen_name))?;

    let mut files_to_write: std::collections::BTreeMap<String, Vec<u8>> =
        std::collections::BTreeMap::new();
    for file in source_data.files.drain(..) {
        let Some(normalized_relative_path) = normalize_relative_import_path(&file.relative_path)
        else {
            continue;
        };
        if normalized_relative_path.starts_with(".git/") {
            continue;
        }
        files_to_write.insert(normalized_relative_path, file.bytes);
    }
    files_to_write.insert(
        SKILL_FILENAME.to_string(),
        adapted_markdown.as_bytes().to_vec(),
    );

    if files_to_write.is_empty() {
        bail!("no importable files found in source");
    }
    if files_to_write.len() > MAX_IMPORTED_SKILL_FILES {
        bail!(
            "skill source has too many files ({} > {})",
            files_to_write.len(),
            MAX_IMPORTED_SKILL_FILES
        );
    }
    let total_bytes = files_to_write.values().map(Vec::len).sum::<usize>();
    if total_bytes > MAX_IMPORTED_SKILL_TOTAL_BYTES {
        bail!(
            "skill source is too large ({} bytes > {} bytes)",
            total_bytes,
            MAX_IMPORTED_SKILL_TOTAL_BYTES
        );
    }

    let skills_root = workspace_dir.join(learn::SKILLS_ROOT_RELATIVE_PATH);
    fs::create_dir_all(&skills_root).with_context(|| {
        format!(
            "failed to create skills directory {}",
            skills_root.display()
        )
    })?;

    let target_dir = skills_root.join(&normalized_name);
    let target_file = target_dir.join(SKILL_FILENAME);
    let existed = target_file.exists();
    if existed && !request.overwrite {
        bail!(
            "`{}` already exists; rerun with `--overwrite` or pick `--name`",
            target_file
                .strip_prefix(workspace_dir)
                .unwrap_or(&target_file)
                .display()
        );
    }

    if request.overwrite && target_dir.exists() {
        fs::remove_dir_all(&target_dir)
            .with_context(|| format!("failed to reset {}", target_dir.display()))?;
    }
    fs::create_dir_all(&target_dir)
        .with_context(|| format!("failed to create skill directory {}", target_dir.display()))?;

    for (relative_path, bytes) in &files_to_write {
        let destination = target_dir.join(relative_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!(
                    "failed to create destination directory {}",
                    parent.display()
                )
            })?;
        }
        fs::write(&destination, bytes)
            .with_context(|| format!("failed to write {}", destination.display()))?;
    }

    let relative_path = target_file
        .strip_prefix(workspace_dir)
        .unwrap_or(&target_file)
        .to_string_lossy()
        .replace('\\', "/");

    Ok(ImportedSkill {
        name: normalized_name,
        relative_path,
        source: source_data.resolved_source,
        changed: existed,
        files_written: files_to_write.len(),
        compatibility,
    })
}

async fn read_skill_source(workspace_dir: &Path, source: &str) -> Result<SkillSourceData> {
    if source.starts_with("http://") || source.starts_with("https://") {
        return read_remote_skill(source).await;
    }

    if source.starts_with("file://") {
        let parsed = Url::parse(source).context("invalid file:// source URL")?;
        let file_path = parsed
            .to_file_path()
            .map_err(|_| anyhow!("invalid file:// path"))?;
        return read_local_skill_path(workspace_dir, file_path.as_path());
    }

    let candidate = PathBuf::from(source);
    read_local_skill_path(workspace_dir, candidate.as_path())
}

fn read_local_skill_path(workspace_dir: &Path, candidate: &Path) -> Result<SkillSourceData> {
    let resolved = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        workspace_dir.join(candidate)
    };
    if resolved.is_dir() {
        let files = read_local_skill_directory(resolved.as_path())?;
        let hint = resolved
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.to_string());
        return Ok(SkillSourceData {
            files,
            resolved_source: resolved.display().to_string(),
            source_name_hint: hint,
        });
    }

    let target = resolved;
    let bytes = fs::read(&target)
        .with_context(|| format!("failed to read local skill source {}", target.display()))?;
    let hint = derive_name_hint_from_path(target.as_path());
    Ok(SkillSourceData {
        files: vec![SkillSourceFile {
            relative_path: SKILL_FILENAME.to_string(),
            bytes,
        }],
        resolved_source: target.display().to_string(),
        source_name_hint: hint,
    })
}

fn read_local_skill_directory(root: &Path) -> Result<Vec<SkillSourceFile>> {
    let mut files: Vec<SkillSourceFile> = Vec::new();
    let mut pending_dirs: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut total_bytes: usize = 0;

    while let Some(directory) = pending_dirs.pop() {
        let entries = fs::read_dir(&directory)
            .with_context(|| format!("failed to read {}", directory.display()))?;
        for entry in entries {
            let entry = entry.with_context(|| {
                format!("failed to read directory entry in {}", directory.display())
            })?;
            let path = entry.path();
            let metadata = entry
                .metadata()
                .with_context(|| format!("failed to read metadata for {}", path.display()))?;
            if metadata.is_dir() {
                pending_dirs.push(path);
                continue;
            }
            if !metadata.is_file() {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(path.as_path())
                .to_string_lossy()
                .replace('\\', "/");
            let Some(normalized_relative) = normalize_relative_import_path(relative.as_str())
            else {
                continue;
            };
            let bytes = fs::read(&path)
                .with_context(|| format!("failed to read local file {}", path.display()))?;
            total_bytes = total_bytes.saturating_add(bytes.len());
            if total_bytes > MAX_IMPORTED_SKILL_TOTAL_BYTES {
                bail!(
                    "skill source is too large ({} bytes > {} bytes)",
                    total_bytes,
                    MAX_IMPORTED_SKILL_TOTAL_BYTES
                );
            }
            files.push(SkillSourceFile {
                relative_path: normalized_relative,
                bytes,
            });
            if files.len() > MAX_IMPORTED_SKILL_FILES {
                bail!(
                    "skill source has too many files ({} > {})",
                    files.len(),
                    MAX_IMPORTED_SKILL_FILES
                );
            }
        }
    }

    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

async fn read_remote_skill(source: &str) -> Result<SkillSourceData> {
    if let Some(github) = parse_github_skill_source(source)? {
        if !github.skill_directory_path.is_empty() {
            match read_remote_github_skill_bundle(&github).await {
                Ok(bundle) => {
                    return Ok(bundle);
                }
                Err(error) => {
                    tracing::warn!(
                        source = %source,
                        error = %error,
                        "GitHub skill bundle fetch failed; falling back to SKILL.md-only import"
                    );
                }
            }
        }
    }

    let (url, hint) = resolve_remote_skill_url(source)?;
    let client = reqwest::Client::new();
    let response = client
        .get(url.clone())
        .header("accept", "text/plain")
        .header("user-agent", "instafy-runtime-agent/skills")
        .send()
        .await
        .with_context(|| format!("failed to fetch {url}"))?;

    if !response.status().is_success() {
        bail!("{} returned {}", url, response.status());
    }

    let text = response
        .text()
        .await
        .with_context(|| format!("failed to read response body from {url}"))?;
    Ok(SkillSourceData {
        files: vec![SkillSourceFile {
            relative_path: SKILL_FILENAME.to_string(),
            bytes: text.into_bytes(),
        }],
        resolved_source: url.to_string(),
        source_name_hint: hint,
    })
}

async fn read_remote_github_skill_bundle(source: &GitHubSkillSource) -> Result<SkillSourceData> {
    let client = reqwest::Client::new();
    let files = fetch_github_directory_files(&client, source).await?;
    let hint = derive_name_hint_from_segments(
        &source
            .skill_directory_path
            .split('/')
            .filter(|segment| !segment.trim().is_empty())
            .map(str::to_string)
            .collect::<Vec<String>>(),
    );
    let resolved_source = match source.kind {
        GitHubSkillSourceKind::Tree => format!(
            "https://github.com/{}/{}/tree/{}/{}",
            source.owner, source.repo, source.branch, source.skill_directory_path
        ),
        GitHubSkillSourceKind::Blob => format!(
            "https://github.com/{}/{}/blob/{}/{}",
            source.owner, source.repo, source.branch, source.skill_file_path
        ),
        GitHubSkillSourceKind::Raw => format!(
            "https://raw.githubusercontent.com/{}/{}/{}/{}",
            source.owner, source.repo, source.branch, source.skill_file_path
        ),
    };
    Ok(SkillSourceData {
        files,
        resolved_source,
        source_name_hint: hint,
    })
}

async fn fetch_github_directory_files(
    client: &reqwest::Client,
    source: &GitHubSkillSource,
) -> Result<Vec<SkillSourceFile>> {
    if source.skill_directory_path.trim().is_empty() {
        bail!("GitHub source must include a skill directory path");
    }

    let mut pending_dirs = vec![source.skill_directory_path.clone()];
    let mut files: Vec<SkillSourceFile> = Vec::new();
    let mut total_bytes: usize = 0;

    while let Some(directory_path) = pending_dirs.pop() {
        let entries =
            fetch_github_directory_listing(client, source, directory_path.as_str()).await?;
        for entry in entries {
            if entry.entry_type.eq_ignore_ascii_case("dir") {
                pending_dirs.push(entry.path);
                continue;
            }
            if !entry.entry_type.eq_ignore_ascii_case("file") {
                continue;
            }

            let relative_path = relative_path_from_prefix(
                source.skill_directory_path.as_str(),
                entry.path.as_str(),
            )
            .ok_or_else(|| anyhow!("unable to resolve relative path for {}", entry.path))?;
            let Some(normalized_relative_path) =
                normalize_relative_import_path(relative_path.as_str())
            else {
                continue;
            };

            let download_url = entry.download_url.clone().unwrap_or_else(|| {
                format!(
                    "https://raw.githubusercontent.com/{}/{}/{}/{}",
                    source.owner, source.repo, source.branch, entry.path
                )
            });
            let bytes = fetch_remote_file_bytes(client, download_url.as_str()).await?;
            total_bytes = total_bytes.saturating_add(bytes.len());
            if total_bytes > MAX_IMPORTED_SKILL_TOTAL_BYTES {
                bail!(
                    "skill source is too large ({} bytes > {} bytes)",
                    total_bytes,
                    MAX_IMPORTED_SKILL_TOTAL_BYTES
                );
            }

            files.push(SkillSourceFile {
                relative_path: normalized_relative_path,
                bytes,
            });

            if files.len() > MAX_IMPORTED_SKILL_FILES {
                bail!(
                    "skill source has too many files ({} > {})",
                    files.len(),
                    MAX_IMPORTED_SKILL_FILES
                );
            }
        }
    }

    files.sort_by(|a, b| a.relative_path.cmp(&b.relative_path));
    Ok(files)
}

async fn fetch_github_directory_listing(
    client: &reqwest::Client,
    source: &GitHubSkillSource,
    directory_path: &str,
) -> Result<Vec<GitHubContentEntry>> {
    let mut url =
        Url::parse("https://api.github.com").context("failed to construct GitHub API base URL")?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| anyhow!("failed to prepare GitHub API path segments"))?;
        segments.push("repos");
        segments.push(source.owner.as_str());
        segments.push(source.repo.as_str());
        segments.push("contents");
        for segment in directory_path
            .split('/')
            .filter(|segment| !segment.is_empty())
        {
            segments.push(segment);
        }
    }
    url.query_pairs_mut()
        .append_pair("ref", source.branch.as_str());

    let response = client
        .get(url.clone())
        .header("accept", "application/vnd.github+json")
        .header("user-agent", "instafy-runtime-agent/skills")
        .send()
        .await
        .with_context(|| format!("failed to fetch {url}"))?;
    if !response.status().is_success() {
        bail!("{} returned {}", url, response.status());
    }

    let payload = response
        .json::<serde_json::Value>()
        .await
        .with_context(|| format!("failed to decode GitHub API response from {url}"))?;

    if let Some(array) = payload.as_array() {
        let mut out = Vec::new();
        for item in array {
            let entry: GitHubContentEntry = serde_json::from_value(item.clone())
                .with_context(|| format!("invalid GitHub content entry from {url}"))?;
            out.push(entry);
        }
        return Ok(out);
    }

    if payload.is_object() {
        let entry: GitHubContentEntry = serde_json::from_value(payload)
            .with_context(|| format!("invalid GitHub content entry from {url}"))?;
        return Ok(vec![entry]);
    }

    bail!("unexpected GitHub API payload at {url}")
}

async fn fetch_remote_file_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .header("accept", "*/*")
        .header("user-agent", "instafy-runtime-agent/skills")
        .send()
        .await
        .with_context(|| format!("failed to fetch {url}"))?;
    if !response.status().is_success() {
        bail!("{} returned {}", url, response.status());
    }
    let bytes = response
        .bytes()
        .await
        .with_context(|| format!("failed to read response body from {url}"))?;
    Ok(bytes.to_vec())
}

fn resolve_remote_skill_url(source: &str) -> Result<(Url, Option<String>)> {
    let parsed = Url::parse(source).with_context(|| format!("invalid source URL `{source}`"))?;

    let Some(host) = parsed.host_str() else {
        bail!("source URL is missing a host");
    };

    if host.eq_ignore_ascii_case("github.com") {
        return resolve_github_url_to_raw_skill(parsed.as_str());
    }

    if host.eq_ignore_ascii_case("raw.githubusercontent.com") {
        let mut url = parsed;
        let mut segments: Vec<String> = url
            .path_segments()
            .map(|value| value.map(str::to_string).collect())
            .unwrap_or_default();
        if !segments
            .last()
            .map(|value| value.eq_ignore_ascii_case(SKILL_FILENAME))
            .unwrap_or(false)
        {
            segments.push(SKILL_FILENAME.to_string());
            let mut path = String::new();
            for segment in &segments {
                path.push('/');
                path.push_str(segment);
            }
            if path.is_empty() {
                path.push('/');
            }
            url.set_path(path.as_str());
        }
        let hint = derive_name_hint_from_url(url.as_str());
        return Ok((url, hint));
    }

    let path = parsed.path();
    if path.ends_with(SKILL_FILENAME) {
        let hint = derive_name_hint_from_url(parsed.as_str());
        return Ok((parsed, hint));
    }

    bail!("unsupported URL format; use a GitHub tree/blob SKILL URL or a direct SKILL.md URL")
}

fn parse_github_skill_source(source: &str) -> Result<Option<GitHubSkillSource>> {
    let parsed = Url::parse(source).with_context(|| format!("invalid source URL `{source}`"))?;
    let Some(host) = parsed.host_str() else {
        bail!("source URL is missing a host");
    };

    if host.eq_ignore_ascii_case("github.com") {
        let segments: Vec<String> = parsed
            .path_segments()
            .map(|value| value.map(str::to_string).collect())
            .unwrap_or_default();
        if segments.len() < 5 {
            bail!(
                "unsupported GitHub URL; expected `/blob/<branch>/.../SKILL.md` or `/tree/<branch>/...`"
            );
        }
        let owner = segments[0].trim().to_string();
        let repo = segments[1].trim().to_string();
        let mode = segments[2].trim().to_ascii_lowercase();
        let branch = segments[3].trim().to_string();
        if owner.is_empty() || repo.is_empty() || branch.is_empty() {
            bail!("invalid GitHub URL segments");
        }

        let remaining = segments[4..].join("/");
        if remaining.trim().is_empty() {
            bail!(
                "unsupported GitHub URL; expected `/blob/<branch>/.../SKILL.md` or `/tree/<branch>/...`"
            );
        }

        let (kind, skill_file_path) = if mode == "tree" {
            (
                GitHubSkillSourceKind::Tree,
                if remaining.ends_with(SKILL_FILENAME) {
                    remaining
                } else {
                    format!("{remaining}/{SKILL_FILENAME}")
                },
            )
        } else if mode == "blob" {
            (
                GitHubSkillSourceKind::Blob,
                if remaining.ends_with(SKILL_FILENAME) {
                    remaining
                } else {
                    format!("{remaining}/{SKILL_FILENAME}")
                },
            )
        } else {
            bail!(
                "unsupported GitHub URL; expected `/blob/<branch>/.../SKILL.md` or `/tree/<branch>/...`"
            );
        };

        let skill_directory_path = parent_relative_path(skill_file_path.as_str());
        return Ok(Some(GitHubSkillSource {
            owner,
            repo,
            branch,
            skill_file_path,
            skill_directory_path,
            kind,
        }));
    }

    if host.eq_ignore_ascii_case("raw.githubusercontent.com") {
        let segments: Vec<String> = parsed
            .path_segments()
            .map(|value| value.map(str::to_string).collect())
            .unwrap_or_default();
        if segments.len() < 4 {
            return Ok(None);
        }
        let owner = segments[0].trim().to_string();
        let repo = segments[1].trim().to_string();
        let branch = segments[2].trim().to_string();
        let remaining = segments[3..].join("/");
        if owner.is_empty() || repo.is_empty() || branch.is_empty() || remaining.is_empty() {
            return Ok(None);
        }
        let skill_file_path = if remaining.ends_with(SKILL_FILENAME) {
            remaining
        } else {
            format!("{remaining}/{SKILL_FILENAME}")
        };
        let skill_directory_path = parent_relative_path(skill_file_path.as_str());
        return Ok(Some(GitHubSkillSource {
            owner,
            repo,
            branch,
            skill_file_path,
            skill_directory_path,
            kind: GitHubSkillSourceKind::Raw,
        }));
    }

    Ok(None)
}

fn resolve_github_url_to_raw_skill(source: &str) -> Result<(Url, Option<String>)> {
    let Some(parsed) = parse_github_skill_source(source)? else {
        bail!(
            "unsupported GitHub URL; expected `/blob/<branch>/.../SKILL.md` or `/tree/<branch>/...`"
        );
    };
    let raw_url = format!(
        "https://raw.githubusercontent.com/{}/{}/{}/{}",
        parsed.owner, parsed.repo, parsed.branch, parsed.skill_file_path
    );
    let parsed_raw = Url::parse(raw_url.as_str())
        .with_context(|| format!("failed to build raw GitHub URL from `{source}`"))?;
    let hint = derive_name_hint_from_url(parsed_raw.as_str());
    Ok((parsed_raw, hint))
}

fn derive_name_hint_from_url(source: &str) -> Option<String> {
    let parsed = Url::parse(source).ok()?;
    let segments: Vec<String> = parsed
        .path_segments()
        .map(|value| value.map(str::to_string).collect())
        .unwrap_or_default();
    derive_name_hint_from_segments(&segments)
}

fn derive_name_hint_from_path(path: &Path) -> Option<String> {
    if path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case(SKILL_FILENAME))
        .unwrap_or(false)
    {
        return path
            .parent()
            .and_then(Path::file_name)
            .and_then(|value| value.to_str())
            .map(|value| value.to_string());
    }

    path.file_stem()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
}

fn derive_name_hint_from_segments(segments: &[String]) -> Option<String> {
    if segments.is_empty() {
        return None;
    }

    let last = segments.last()?.as_str();
    if last.eq_ignore_ascii_case(SKILL_FILENAME) {
        return segments.iter().rev().nth(1).map(|value| value.to_string());
    }

    Some(last.to_string())
}

fn parent_relative_path(path: &str) -> String {
    let mut segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if !segments.is_empty() {
        segments.pop();
    }
    segments.join("/")
}

fn relative_path_from_prefix(prefix: &str, full_path: &str) -> Option<String> {
    let normalized_prefix = prefix.trim().trim_matches('/');
    let normalized_full = full_path.trim().trim_matches('/');
    if normalized_prefix.is_empty() {
        if normalized_full.is_empty() {
            return None;
        }
        return Some(normalized_full.to_string());
    }
    if normalized_full.eq_ignore_ascii_case(normalized_prefix) {
        return Some(SKILL_FILENAME.to_string());
    }
    let prefix_with_slash = format!("{normalized_prefix}/");
    normalized_full
        .strip_prefix(prefix_with_slash.as_str())
        .map(|value| value.to_string())
}

fn normalize_relative_import_path(raw: &str) -> Option<String> {
    let normalized = raw.replace('\\', "/");
    let mut out: Vec<&str> = Vec::new();
    for segment in normalized.split('/') {
        let trimmed = segment.trim();
        if trimmed.is_empty() || trimmed == "." {
            continue;
        }
        if trimmed == ".." {
            return None;
        }
        out.push(trimmed);
    }
    if out.is_empty() {
        return None;
    }
    Some(out.join("/"))
}

fn locate_primary_skill_file_index(files: &[SkillSourceFile]) -> Option<usize> {
    if let Some(index) = files
        .iter()
        .position(|file| file.relative_path.eq_ignore_ascii_case(SKILL_FILENAME))
    {
        return Some(index);
    }

    files.iter().position(|file| {
        Path::new(file.relative_path.as_str())
            .file_name()
            .and_then(|value| value.to_str())
            .map(|value| value.eq_ignore_ascii_case(SKILL_FILENAME))
            .unwrap_or(false)
    })
}

fn adapt_skill_markdown_for_instafy(
    normalized_markdown: &str,
    source: &str,
) -> (String, CompatibilityReport) {
    let flavor = detect_skill_source_flavor(normalized_markdown, source);
    let mut report = CompatibilityReport {
        flavor,
        rewrites: Vec::new(),
        warnings: Vec::new(),
    };
    let mut output = normalized_markdown.to_string();

    if flavor == SkillSourceFlavor::Claude {
        let mut rewrite_count = 0usize;
        let replacements: [(&str, &str); 3] = [
            ("<project>/.claude/skills/", ".agents/skills/"),
            ("~/.claude/skills/", ".agents/skills/"),
            (".claude/skills/", ".agents/skills/"),
        ];
        for (from, to) in replacements {
            if output.contains(from) {
                let occurrences = output.matches(from).count();
                output = output.replace(from, to);
                rewrite_count = rewrite_count.saturating_add(occurrences);
            }
        }

        if rewrite_count > 0 {
            report.rewrites.push(format!(
                "{} Claude skill path reference(s) were mapped to `.agents/skills`.",
                rewrite_count
            ));
        }

        if output.contains("/plugin ") || output.contains(".claude/plugins/") {
            report.warnings.push(
                "Claude plugin commands/paths were detected. They are reference-only in Instafy."
                    .to_string(),
            );
        }

        let lower_output = output.to_ascii_lowercase();
        if lower_output.contains("playwright") {
            report.warnings.push(
                "If this imported skill includes browser automation, reconcile it with the pinned Instafy browser workflow skill instead of replaying foreign setup/bootstrap flows."
                    .to_string(),
            );
        }

        report.warnings.push(
            "Use Instafy-supported tools (MCP tools, shell, workspace files) when this skill references Claude-only tooling."
                .to_string(),
        );

        output = insert_instafy_compatibility_note(output.as_str(), &report);
    }

    (normalize_markdown_content(output.as_str()), report)
}

fn detect_skill_source_flavor(content: &str, source: &str) -> SkillSourceFlavor {
    let lower_content = content.to_ascii_lowercase();
    let lower_source = source.to_ascii_lowercase();

    if lower_content.contains(".claude/")
        || lower_content.contains("claude code")
        || lower_content.contains("anthropic")
        || lower_source.contains("claude")
    {
        return SkillSourceFlavor::Claude;
    }

    SkillSourceFlavor::Generic
}

fn insert_instafy_compatibility_note(content: &str, report: &CompatibilityReport) -> String {
    if content.contains(INSTAFY_COMPAT_MARKER) {
        return content.to_string();
    }

    let mut note = String::new();
    note.push_str(INSTAFY_COMPAT_MARKER);
    note.push_str("\n\n## Instafy Compatibility\n");
    note.push_str("- Imported from a Claude-oriented skill format.\n");
    if !report.rewrites.is_empty() {
        for rewrite in &report.rewrites {
            note.push_str(&format!("- {rewrite}\n"));
        }
    }
    if !report.warnings.is_empty() {
        for warning in &report.warnings {
            note.push_str(&format!("- {warning}\n"));
        }
    }
    note.push_str(
        "- If this imported skill includes browser automation, align it with the pinned Instafy browser workflow skill instead of assuming foreign setup/bootstrap flows.\n",
    );
    note.push_str(
        "- Keep commands/tool calls aligned with this workspace runtime instead of relying on Claude-only plugin flows.\n",
    );
    note.push_str(
        "- Follow `.agents/skills/instafy-skill-import-compat/SKILL.md` for Instafy-native adaptation patterns.\n",
    );
    note.push('\n');

    let mut merged = content.trim_end_matches('\n').to_string();
    if !merged.is_empty() {
        merged.push_str("\n\n");
    }
    merged.push_str(note.trim_end());
    merged.push('\n');
    merged
}

fn normalize_markdown_content(content: &str) -> String {
    let normalized = content.replace("\r\n", "\n");
    if normalized.ends_with('\n') {
        normalized
    } else {
        format!("{normalized}\n")
    }
}

fn extract_frontmatter_name(content: &str) -> Option<String> {
    let mut lines = content.lines();
    let first = lines.next()?.trim();
    if first != "---" {
        return None;
    }

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("name:") {
            let candidate = value.trim().trim_matches('"').trim_matches('\'').trim();
            if !candidate.is_empty() {
                return Some(candidate.to_string());
            }
        }
    }

    None
}

fn normalize_skill_name(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut previous_dash = false;

    for ch in raw.trim().chars() {
        let mapped = match ch {
            'A'..='Z' => ch.to_ascii_lowercase(),
            'a'..='z' | '0'..='9' => ch,
            '-' | '_' | ' ' | '/' | '\\' | '.' => '-',
            _ => continue,
        };

        if mapped == '-' {
            if out.is_empty() || previous_dash {
                continue;
            }
            previous_dash = true;
            out.push('-');
        } else {
            previous_dash = false;
            out.push(mapped);
        }
    }

    while out.ends_with('-') {
        out.pop();
    }

    if out.is_empty() {
        return None;
    }

    Some(out)
}

fn list_installed_skills(workspace_dir: &Path) -> Vec<(String, String)> {
    let skills_root = workspace_dir.join(learn::SKILLS_ROOT_RELATIVE_PATH);
    if !skills_root.is_dir() {
        return Vec::new();
    }

    let mut out: Vec<(String, String)> = Vec::new();
    let entries = match fs::read_dir(&skills_root) {
        Ok(value) => value,
        Err(_) => return Vec::new(),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_file = path.join(SKILL_FILENAME);
        if !skill_file.is_file() {
            continue;
        }
        let name = match path.file_name().and_then(|value| value.to_str()) {
            Some(value) => value.to_string(),
            None => continue,
        };
        let rel = skill_file
            .strip_prefix(workspace_dir)
            .unwrap_or(&skill_file)
            .to_string_lossy()
            .replace('\\', "/");
        out.push((name, rel));
    }

    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn usage_text() -> &'static str {
    "Skills command usage:\n- `/skills list`\n- `/skills import <source> [--name <skill-name>] [--overwrite]`\n\nSupported import sources:\n- GitHub tree URL: `https://github.com/<owner>/<repo>/tree/<branch>/<path-to-skill-dir>`\n- GitHub blob URL: `https://github.com/<owner>/<repo>/blob/<branch>/<path>/SKILL.md`\n- Direct `SKILL.md` URL\n- Local path to `SKILL.md` (or a directory containing it)\n\nNotes:\n- Directory-based imports bring companion files (for example `run.js`, `lib/*`, `package.json`) when available."
}

#[cfg(test)]
mod tests {
    use super::{
        INSTAFY_COMPAT_MARKER, SKILL_FILENAME, SkillsRequest, adapt_skill_markdown_for_instafy,
        normalize_relative_import_path, normalize_skill_name, parse_github_skill_source,
        parse_skills_request, resolve_github_url_to_raw_skill,
    };

    #[test]
    fn parse_skills_request_supports_list_and_import() {
        assert_eq!(parse_skills_request("/skills"), Some(SkillsRequest::List));
        assert_eq!(
            parse_skills_request("/skill list"),
            Some(SkillsRequest::List)
        );

        let parsed = parse_skills_request("/skills import ./tmp/skill --name my-skill --overwrite");
        match parsed {
            Some(SkillsRequest::Import(request)) => {
                assert_eq!(request.source, "./tmp/skill");
                assert_eq!(request.skill_name.as_deref(), Some("my-skill"));
                assert!(request.overwrite);
            }
            _ => panic!("expected import request"),
        }
    }

    #[test]
    fn parse_skills_request_returns_help_for_invalid_subcommand() {
        match parse_skills_request("/skills remove foo") {
            Some(SkillsRequest::Help { reason }) => {
                assert!(
                    reason
                        .as_deref()
                        .unwrap_or("")
                        .contains("Unsupported skills subcommand")
                );
            }
            _ => panic!("expected help response"),
        }
    }

    #[test]
    fn resolve_github_blob_to_raw_skill_url() {
        let (url, hint) = resolve_github_url_to_raw_skill(
            "https://github.com/acme/repo/blob/main/skills/review/SKILL.md",
        )
        .expect("expected valid github blob URL");

        assert_eq!(
            url.as_str(),
            "https://raw.githubusercontent.com/acme/repo/main/skills/review/SKILL.md"
        );
        assert_eq!(hint.as_deref(), Some("review"));
    }

    #[test]
    fn resolve_github_tree_to_raw_skill_url() {
        let (url, hint) =
            resolve_github_url_to_raw_skill("https://github.com/acme/repo/tree/main/skills/review")
                .expect("expected valid github tree URL");

        assert_eq!(
            url.as_str(),
            "https://raw.githubusercontent.com/acme/repo/main/skills/review/SKILL.md"
        );
        assert_eq!(hint.as_deref(), Some("review"));
    }

    #[test]
    fn normalize_skill_name_sanitizes_symbols_and_separators() {
        assert_eq!(
            normalize_skill_name("  Team Review Skill  "),
            Some("team-review-skill".to_string())
        );
        assert_eq!(normalize_skill_name("foo/bar"), Some("foo-bar".to_string()));
        assert_eq!(normalize_skill_name("***"), None);
    }

    #[test]
    fn skill_filename_constant_matches_expected() {
        assert_eq!(SKILL_FILENAME, "SKILL.md");
    }

    #[test]
    fn parse_github_skill_source_for_blob_infers_directory() {
        let parsed = parse_github_skill_source(
            "https://github.com/acme/repo/blob/main/skills/review/SKILL.md",
        )
        .expect("expected parser to succeed")
        .expect("expected github source");

        assert_eq!(parsed.owner, "acme");
        assert_eq!(parsed.repo, "repo");
        assert_eq!(parsed.branch, "main");
        assert_eq!(parsed.skill_file_path, "skills/review/SKILL.md");
        assert_eq!(parsed.skill_directory_path, "skills/review");
    }

    #[test]
    fn normalize_relative_import_path_rejects_parent_segments() {
        assert_eq!(normalize_relative_import_path("docs/../SKILL.md"), None);
        assert_eq!(
            normalize_relative_import_path("./helpers/run.js"),
            Some("helpers/run.js".to_string())
        );
    }

    #[test]
    fn adapt_skill_markdown_rewrites_claude_paths_and_injects_note() {
        let input = concat!(
            "---\n",
            "name: demo\n",
            "---\n\n",
            "Install at ~/.claude/skills/demo\n",
            "Then run /plugin install demo\n",
        );
        let (adapted, report) =
            adapt_skill_markdown_for_instafy(input, "https://github.com/acme/claude-demo");
        assert!(adapted.contains(".agents/skills/demo"));
        assert!(adapted.contains(INSTAFY_COMPAT_MARKER));
        assert_eq!(report.flavor.as_str(), "claude");
        assert!(!report.rewrites.is_empty());
        assert!(!report.warnings.is_empty());
    }

    #[test]
    fn adapt_skill_markdown_appends_compatibility_note_after_existing_content() {
        let input = concat!(
            "# Playwright Browser Automation\n\n",
            "Use this skill to automate browser flows.\n",
        );
        let (adapted, _report) =
            adapt_skill_markdown_for_instafy(input, "https://github.com/acme/claude-demo");
        let title_index = adapted
            .find("# Playwright Browser Automation")
            .expect("expected original heading");
        let compat_index = adapted
            .find("## Instafy Compatibility")
            .expect("expected compatibility note heading");
        assert!(
            title_index < compat_index,
            "compatibility note should be appended after the skill content"
        );
    }
}
