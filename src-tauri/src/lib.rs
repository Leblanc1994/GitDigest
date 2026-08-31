use serde::Serialize;
use std::{collections::HashSet, path::Path, process::Command};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GitCommit {
    hash: String,
    author: String,
    author_email: String,
    date: String,
    summary: String,
    files: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectActivity {
    name: String,
    path: String,
    branch: String,
    commits: Vec<GitCommit>,
    changed_files: usize,
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

#[tauri::command]
fn scan_git_activity(paths: Vec<String>, start_date: String, end_date: String, only_mine: bool) -> Result<Vec<ProjectActivity>, String> {
    if paths.is_empty() { return Err("请至少选择一个 Git 项目。".to_string()); }
    paths.iter().map(|path| scan_one_project(path, &start_date, &end_date, only_mine)).collect()
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![scan_git_activity])
        .run(tauri::generate_context!())
        .expect("启动日报引擎失败");
}
