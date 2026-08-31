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

fn scan_one_project(path: &str, start: &str, end: &str, only_mine: bool) -> Result<ProjectActivity, String> {
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
            summary: fields[4].trim().to_string(), files,
        })
    }).collect();
    let name = Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or(path).to_string();
    Ok(ProjectActivity { name, path: path.to_string(), branch: branch.trim().to_string(), commits, changed_files: all_files.len() })
}

fn ai_source(activities: &[ProjectActivity]) -> Vec<serde_json::Value> {
    activities.iter().map(|activity| serde_json::json!({
        "project": activity.name,
        "branch": activity.branch,
        "commits": activity.commits.iter().map(|commit| serde_json::json!({
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
            { "role": "system", "content": "你是严谨的中文工作周报助手。仅依据提供的 Git 提交摘要和文件路径撰写，不要虚构需求、业务结果、测试完成情况、进度、风险或计划。合并语义重复的提交，使用简洁、可汇报的中文。项目没有提交时不要为它生成工作项。footer 表示待跟进或下周计划；如果提交记录没有依据，请写“待根据业务排期和验收反馈确认后续工作。”" },
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
fn scan_git_activity(paths: Vec<String>, start_date: String, end_date: String, only_mine: bool) -> Result<Vec<ProjectActivity>, String> {
    if paths.is_empty() { return Err("请至少选择一个 Git 项目。".to_string()); }
    paths.iter().map(|path| scan_one_project(path, &start_date, &end_date, only_mine)).collect()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan_git_activity, enhance_report_with_ai])
        .run(tauri::generate_context!())
        .expect("启动日报引擎失败");
}
