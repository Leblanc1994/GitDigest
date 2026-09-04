use serde::{Deserialize, Serialize};
use std::{collections::HashSet, env, path::Path, process::Command};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    author: String,
    author_email: String,
    date: String,
    summary: String,
    files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    staged_files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unstaged_files: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    untracked_files: Option<usize>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectActivity {
    name: String,
    path: String,
    branch: String,
    commits: Vec<GitCommit>,
    changed_files: usize,
}

#[derive(Deserialize, Serialize)]
struct AiGroup {
    scope: String,
    actions: Vec<String>,
}

#[derive(Deserialize, Serialize)]
struct AiSection {
    project: String,
    groups: Vec<AiGroup>,
}

#[derive(Deserialize, Serialize)]
struct AiReport {
    overview: String,
    sections: Vec<AiSection>,
    footer: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PmsConfig {
    base_url: String,
    tenant_name: String,
    tenant_id: serde_json::Value,
    username: String,
    // The webview encrypts this with the PMS-provided AES key before native code receives it.
    password: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PmsEntry {
    client_id: String,
    project_id: serde_json::Value,
    date: String,
    period_key: String,
    man_days: f64,
    remark: String,
}

fn pms_base_url(value: &str) -> Result<String, String> {
    let base = value.trim().trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) { return Err("工时系统地址无效。".to_string()); }
    Ok(base.to_string())
}

fn url_encode(value: &str) -> String {
    value.bytes().flat_map(|byte| match byte {
        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => vec![(byte as char).to_string()],
        _ => vec![format!("%{:02X}", byte)],
    }).collect()
}

fn pms_call(base: &str, path: &str, method: &str, tenant_id: &str, token: Option<&str>, body: Option<&serde_json::Value>) -> Result<serde_json::Value, String> {
    let endpoint = format!("{base}/admin-api{path}");
    let tenant_header = format!("tenant-id: {tenant_id}");
    let mut command = Command::new("curl");
    command.args(["--silent", "--show-error", "--max-time", "20", "-X", method, &endpoint, "-H", "content-type: application/json", "-H", &tenant_header]);
    let auth_header;
    if let Some(access_token) = token { auth_header = format!("Authorization: Bearer {access_token}"); command.args(["-H", &auth_header]); }
    let body_text;
    if let Some(value) = body { body_text = serde_json::to_string(value).map_err(|_| "工时请求格式无效。".to_string())?; command.args(["--data-binary", &body_text]); }
    let output = command.output().map_err(|_| "无法调用 curl。请确认系统已安装 curl。".to_string())?;
    let response: serde_json::Value = serde_json::from_slice(&output.stdout).map_err(|_| "工时系统返回格式无效。".to_string())?;
    if response.get("code").and_then(|value| value.as_i64()) != Some(0) { return Err(response.get("msg").and_then(|value| value.as_str()).unwrap_or("工时系统请求失败。").to_string()); }
    Ok(response.get("data").cloned().unwrap_or(serde_json::Value::Null))
}

fn pms_session(config: &PmsConfig) -> Result<(String, String, String), String> {
    let base = pms_base_url(&config.base_url)?;
    let tenant_id = config.tenant_id.to_string().trim_matches('"').to_string();
    let login = serde_json::json!({"tenantName": config.tenant_name, "username": config.username, "password": config.password, "captchaVerification": "", "rememberMe": false});
    let session = pms_call(&base, "/system/auth/login", "POST", &tenant_id, None, Some(&login))?;
    let token = session.get("accessToken").and_then(|value| value.as_str()).ok_or_else(|| "工时系统登录未返回访问凭证。".to_string())?;
    Ok((base, tenant_id, token.to_string()))
}

#[tauri::command]
fn pms_connection_info(base_url: String, tenant_name: String) -> Result<serde_json::Value, String> {
    let base = pms_base_url(&base_url)?;
    let tenant_id = pms_call(&base, &format!("/system/tenant/get-id-by-name?name={}", url_encode(&tenant_name)), "GET", "0", None, None)?;
    let id_text = tenant_id.to_string().trim_matches('"').to_string();
    let encryption_key = pms_call(&base, "/infra/config/get-value-by-key?key=sys.private.key", "GET", &id_text, None, None)?;
    Ok(serde_json::json!({"tenantId": tenant_id, "encryptionKey": encryption_key}))
}

#[tauri::command]
fn pms_projects(config: PmsConfig) -> Result<serde_json::Value, String> {
    let (base, tenant_id, token) = pms_session(&config)?;
    let page = pms_call(&base, "/pm/timesheet/project-page?pageNo=1&pageSize=500", "GET", &tenant_id, Some(&token), None)?;
    Ok(serde_json::json!({"projects": page.get("list").cloned().unwrap_or_else(|| serde_json::json!([]))}))
}

#[tauri::command]
fn pms_push(config: PmsConfig, entries: Vec<PmsEntry>) -> Result<serde_json::Value, String> {
    if entries.is_empty() { return Err("请至少选择一条待推送工时。".to_string()); }
    let (base, tenant_id, token) = pms_session(&config)?;
    let mut results = Vec::new();
    for entry in entries {
        let project_id = entry.project_id.to_string().trim_matches('"').to_string();
        if project_id.is_empty() || entry.man_days <= 0.0 || entry.remark.trim().is_empty() { results.push(serde_json::json!({"clientId": entry.client_id, "status":"failed", "message":"项目、工时和工作内容均为必填。"})); continue; }
        match (|| -> Result<(), String> {
            let period = pms_call(&base, &format!("/pm/timesheet/get-period?projectId={}&viewMode=week&periodKey={}", url_encode(&project_id), url_encode(&entry.period_key)), "GET", &tenant_id, Some(&token), None)?;
            if period.pointer(&format!("/entries/{}", entry.date)).and_then(|value| value.as_f64()).unwrap_or(0.0) > 0.0 { return Err("已有工时".to_string()); }
            let mut values = period.get("entries").and_then(|value| value.as_object()).cloned().unwrap_or_default(); values.insert(entry.date.clone(), serde_json::json!((entry.man_days * 100.0).round() / 100.0));
            let mut contents = period.get("workContents").and_then(|value| value.as_object()).cloned().unwrap_or_default(); contents.insert(entry.date.clone(), serde_json::json!(entry.remark.trim()));
            let payload = serde_json::json!({"projectId": entry.project_id, "viewMode":"week", "periodKey":entry.period_key, "entries":values, "workContents":contents});
            pms_call(&base, "/pm/timesheet/period", "POST", &tenant_id, Some(&token), Some(&payload))?; Ok(())
        })() { Ok(()) => results.push(serde_json::json!({"clientId":entry.client_id,"status":"submitted","message":"已推送。"})), Err(message) if message == "已有工时" => results.push(serde_json::json!({"clientId":entry.client_id,"status":"skipped","message":"该项目当天已有已填报工时，未覆盖。"})), Err(message) => results.push(serde_json::json!({"clientId":entry.client_id,"status":"failed","message":message})), }
    }
    Ok(serde_json::json!({"results":results}))
}

fn git_output(path: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(path)
        .args(args)
        .output()
        .map_err(|_| "无法调用 Git。请确认 Git 已安装。".to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn git_user_email(path: &str) -> String {
    git_output(path, &["config", "--get", "user.email"])
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

fn working_tree_change(path: &str) -> Result<Option<GitCommit>, String> {
    let output = git_output(path, &["status", "--porcelain=v1", "-z", "--untracked-files=normal"])?;
    let untracked_paths: Vec<String> = git_output(path, &["ls-files", "--others", "--exclude-standard"])?
        .lines().map(str::trim).filter(|file| !file.is_empty()).map(String::from).collect();
    let entries: Vec<&str> = output.split('\0').collect();
    let mut files = Vec::new();
    let mut staged = 0;
    let mut unstaged = 0;
    let mut untracked = 0;
    let mut index = 0;
    while index < entries.len() {
        let entry = entries[index];
        if entry.is_empty() { index += 1; continue; }
        let status = &entry[..2];
        let file = entry.get(3..).unwrap_or("").trim();
        if status == "??" { untracked += 1; }
        else {
            if !file.is_empty() { files.push(file.to_string()); }
            if &status[0..1] != " " { staged += 1; }
            if &status[1..2] != " " { unstaged += 1; }
            if (&status[0..1] == "R" || &status[0..1] == "C") && index + 1 < entries.len() { index += 1; }
        }
        index += 1;
    }
    files.extend(untracked_paths.iter().cloned());
    if !untracked_paths.is_empty() { untracked = untracked_paths.len(); }
    if files.is_empty() { return Ok(None); }
    let mut parts = Vec::new();
    if staged > 0 { parts.push(format!("已暂存 {staged} 个文件")); }
    if unstaged > 0 { parts.push(format!("未暂存 {unstaged} 个文件")); }
    if untracked > 0 { parts.push(format!("新增未跟踪 {untracked} 个文件")); }
    Ok(Some(GitCommit {
        hash: "working-tree".to_string(), author: "本地工作区".to_string(), author_email: String::new(), date: String::new(),
        summary: format!("未提交本地变更（{}）", parts.join("，")), files, source: Some("working-tree".to_string()),
        staged_files: Some(staged), unstaged_files: Some(unstaged), untracked_files: Some(untracked),
    }))
}

fn scan_one_project(path: &str, start: &str, end: &str, only_mine: bool, include_uncommitted: bool) -> Result<ProjectActivity, String> {
    if !Path::new(path).is_dir() {
        return Err(format!("目录不存在：{path}"));
    }
    git_output(path, &["rev-parse", "--is-inside-work-tree"])?;
    let branch = git_output(path, &["rev-parse", "--abbrev-ref", "HEAD"])?;
    let author_email = git_user_email(path);
    if only_mine && author_email.is_empty() {
        return Err(format!("{} 未配置 git user.email，无法识别你的提交。", Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or(path)));
    }
    let log = git_output(path, &[
        "log", "--no-merges", "--date=short",
        &format!("--since={start} 00:00:00"),
        &format!("--until={end} 23:59:59"),
        "--pretty=format:%H%x1f%an%x1f%ad%x1f%ae%x1f%s%x1e", "--name-only",
    ])?;
    let mut all_files = HashSet::new();
    let commits = log.split('\u{1e}').filter_map(|record| {
        let fields: Vec<&str> = record.trim().split('\u{1f}').collect();
        if fields.len() < 5 || fields[0].trim().is_empty() { return None; }
        if only_mine && fields[3].trim().to_lowercase() != author_email { return None; }
        let files: Vec<String> = fields[5..].iter()
            .flat_map(|part| part.lines())
            .map(str::trim).filter(|file| !file.is_empty())
            .map(String::from).collect();
        all_files.extend(files.iter().cloned());
        Some(GitCommit {
            hash: fields[0].trim().to_string(), author: fields[1].trim().to_string(),
            author_email: fields[3].trim().to_string(), date: fields[2].trim().to_string(),
            summary: fields[4].trim().to_string(), files, source: Some("commit".to_string()),
            staged_files: None, unstaged_files: None, untracked_files: None,
        })
    }).collect::<Vec<_>>();
    let mut commits = commits;
    if include_uncommitted {
        if let Some(change) = working_tree_change(path)? { all_files.extend(change.files.iter().cloned()); commits.push(change); }
    }
    let name = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path).to_string();
    Ok(ProjectActivity { name, path: path.to_string(), branch: branch.trim().to_string(), commits, changed_files: all_files.len() })
}

fn ai_source(activities: &[ProjectActivity]) -> Vec<serde_json::Value> {
    activities.iter().map(|activity| serde_json::json!({
        "project": activity.name,
        "branch": activity.branch,
        "changes": activity.commits.iter().map(|commit| serde_json::json!({
            "source": commit.source.as_deref().unwrap_or("commit"),
            "date": commit.date,
            "summary": commit.summary,
            "files": commit.files.iter().take(30).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })).collect()
}

fn ai_endpoint(base_url: &str) -> Result<String, String> {
    let value = base_url.trim().trim_end_matches('/');
    if !(value.starts_with("https://") || value.starts_with("http://")) {
        return Err("Base URL 必须以 http:// 或 https:// 开头。".to_string());
    }
    Ok(if value.ends_with("/responses") { value.to_string() } else { format!("{value}/responses") })
}

#[tauri::command]
fn enhance_report_with_ai(activities: Vec<ProjectActivity>, mode: String, base_url: String, api_key: String) -> Result<AiReport, String> {
    if mode != "daily" && mode != "weekly" { return Err("报告类型无效。".to_string()); }
    if api_key.trim().is_empty() { return Err("请填写 AI API Key。".to_string()); }
    let model = env::var("OPENAI_MODEL").unwrap_or_else(|_| "gpt-5.4".to_string());
    let schema = serde_json::json!({
        "type": "object", "additionalProperties": false,
        "properties": {
            "overview": { "type": "string" },
            "sections": { "type": "array", "items": {
                "type": "object", "additionalProperties": false,
                "properties": {
                    "project": { "type": "string" },
                    "groups": { "type": "array", "items": {
                        "type": "object", "additionalProperties": false,
                        "properties": { "scope": { "type": "string" }, "actions": { "type": "array", "items": { "type": "string" } } },
                        "required": ["scope", "actions"]
                    }}
                }, "required": ["project", "groups"]
            }},
            "footer": { "type": "string" }
        },
        "required": ["overview", "sections", "footer"]
    });
    let body = serde_json::json!({
        "model": model,
        "input": [
            { "role": "system", "content": "你是严谨的中文工作周报助手。仅依据提供的 Git 变更摘要和文件路径撰写，不要虚构需求、业务结果、测试完成情况、进度、风险或计划。source 为 working-tree 的内容是尚未提交的本地改动，必须明确表述为“已修改/待提交”，不得写成“已完成”或“已上线”。合并语义重复的变更，使用简洁、可汇报的中文。项目没有变更时不要为它生成工作项。footer 表示待跟进或下周计划；如果变更记录没有依据，请写“待根据业务排期和验收反馈确认后续工作。”" },
            { "role": "user", "content": format!("请整理一份{}。Git 依据如下：\\n{}", if mode == "weekly" { "周报" } else { "日报" }, serde_json::to_string(&ai_source(&activities)).unwrap_or_default()) }
        ],
        "text": { "format": { "type": "json_schema", "name": "git_report", "strict": true, "schema": schema } }
    });
    let authorization = format!("Authorization: Bearer {}", api_key.trim());
    let request = serde_json::to_string(&body).map_err(|_| "AI 请求格式无效。".to_string())?;
    let endpoint = ai_endpoint(&base_url)?;
    let response = Command::new("curl")
        .args(["--silent", "--show-error", "--max-time", "45", "-X", "POST", &endpoint])
        .args(["-H", "content-type: application/json", "-H", &authorization, "--data-binary", &request])
        .output().map_err(|_| "无法调用 curl。请确认系统已安装 curl。".to_string())?;
    let payload: serde_json::Value = serde_json::from_slice(&response.stdout)
        .map_err(|_| if response.status.success() { "AI 返回格式无效，请重试。".to_string() } else { "无法连接 AI 服务。".to_string() })?;
    if let Some(message) = payload.pointer("/error/message").and_then(|value| value.as_str()) {
        return Err(message.to_string());
    }
    if !response.status.success() { return Err("AI 服务请求失败。".to_string()); }
    let output = payload.get("output_text").and_then(|value| value.as_str()).map(String::from).or_else(|| {
        payload.get("output").and_then(|value| value.as_array()).map(|items| items.iter().flat_map(|item| {
            item.get("content").and_then(|value| value.as_array()).into_iter().flatten()
                .filter_map(|content| content.get("text").and_then(|value| value.as_str()))
        }).collect::<String>())
    }).filter(|value| !value.is_empty()).ok_or_else(|| "AI 未返回可用的报告内容。".to_string())?;
    serde_json::from_str(&output).map_err(|_| "AI 返回格式无效，请重试。".to_string())
}

#[tauri::command]
fn scan_git_activity(paths: Vec<String>, start_date: String, end_date: String, only_mine: bool, include_uncommitted: bool) -> Result<Vec<ProjectActivity>, String> {
    if paths.is_empty() { return Err("请至少选择一个 Git 项目。".to_string()); }
    paths.iter().map(|path| scan_one_project(path, &start_date, &end_date, only_mine, include_uncommitted)).collect()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan_git_activity, enhance_report_with_ai, pms_connection_info, pms_projects, pms_push])
        .run(tauri::generate_context!())
        .expect("启动日报引擎失败");
}
