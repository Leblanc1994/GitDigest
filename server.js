import { createServer } from 'node:http';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, extname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname);
const staticRoot = resolve(root, 'dist');
const port = Number(process.env.PORT || 4173);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  console.log(line.trim());
  appendFile(resolve(root, 'daily-engine.log'), line).catch(() => {});
}

function send(res, status, body, contentType = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function pickFoldersMac() {
  const script = [
    'set selectedFolders to choose folder with prompt "选择 Git 项目目录：" with multiple selections allowed',
    'set outputPaths to {}',
    'repeat with selectedFolder in selectedFolders',
    'set end of outputPaths to POSIX path of selectedFolder',
    'end repeat',
    "set AppleScript's text item delimiters to linefeed",
    'return outputPaths as text',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('osascript', ['-e', script], { maxBuffer: 1024 * 1024 });
    return stdout.trim().split('\n').map(path => path.trim()).filter(Boolean);
  } catch (error) {
    if (error.code === 1 && String(error.stderr).includes('-128')) return [];
    throw new Error(`无法打开目录选择窗口：${String(error.stderr || error.message).trim()}`);
  }
}

async function pickFoldersWindows() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$paths = New-Object System.Collections.Generic.List[string]',
    'do {',
    '  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "  $dialog.Description = '选择 Git 项目目录（可连续选择多个）'",
    '  $dialog.ShowNewFolderButton = $false',
    '  $result = $dialog.ShowDialog()',
    '  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { break }',
    '  [void]$paths.Add($dialog.SelectedPath)',
    "  $more = [System.Windows.Forms.MessageBox]::Show('是否继续添加项目目录？', '日报引擎', [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)",
    '} while ($more -eq [System.Windows.Forms.DialogResult]::Yes)',
    '$paths -join [Environment]::NewLine',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, maxBuffer: 1024 * 1024 });
    return stdout.trim().split(/\r?\n/).map(path => path.trim()).filter(Boolean);
  } catch (error) {
    throw new Error(`无法打开 Windows 目录选择窗口：${String(error.stderr || error.message).trim()}`);
  }
}

async function pickFolders() {
  if (process.platform === 'darwin') return pickFoldersMac();
  if (process.platform === 'win32') return pickFoldersWindows();
  throw new Error('当前系统暂不支持原生目录选择，请在 macOS 或 Windows 上运行。');
}

async function git(path, args) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, ...args], { maxBuffer: 10 * 1024 * 1024, timeout: 20_000, killSignal: 'SIGTERM' });
    return stdout;
  } catch (error) {
    if (error.killed || error.signal === 'SIGTERM') throw new Error('Git 读取超时（20 秒）。请确认项目目录可正常访问。');
    throw new Error(String(error.stderr || error.message).trim() || 'Git 命令执行失败');
  }
}

async function gitUserEmail(path) {
  try {
    return (await git(path, ['config', '--get', 'user.email'])).trim().toLowerCase();
  } catch {
    return '';
  }
}

async function scanProject(path, startDate, endDate, onlyMine) {
  const info = await stat(path).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`目录不存在：${path}`);
  await git(path, ['rev-parse', '--is-inside-work-tree']);
  const branch = (await git(path, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const authorEmail = await gitUserEmail(path);
  if (onlyMine && !authorEmail) throw new Error(`${basename(path)} 未配置 git user.email，无法识别你的提交。`);
  const output = await git(path, [
    'log', '--no-merges', '--date=short', `--since=${startDate} 00:00:00`, `--until=${endDate} 23:59:59`,
    '--pretty=format:%x1e%H%x1f%an%x1f%ad%x1f%ae%x1f%s%x1f', '--name-only',
  ]);
  const changedFiles = new Set();
  const commits = output.split('\x1e').flatMap(record => {
    const fields = record.trim().split('\x1f');
    if (fields.length < 5 || !fields[0].trim()) return [];
    if (onlyMine && fields[3].trim().toLowerCase() !== authorEmail) return [];
    const files = fields.slice(5).flatMap(field => field.split('\n')).map(file => file.trim()).filter(Boolean);
    files.forEach(file => changedFiles.add(file));
    return [{ hash: fields[0].trim(), author: fields[1].trim(), authorEmail: fields[3].trim(), date: fields[2].trim(), summary: fields[4].trim(), files }];
  });
  return { name: basename(path), path, branch, authorEmail, commits, changedFiles: changedFiles.size };
}

async function handleApi(req, res) {
  try {
    if (req.url === '/api/select-projects' && req.method === 'POST') {
      log('打开项目目录选择窗口');
      const paths = await pickFolders();
      log(`已选择 ${paths.length} 个目录`);
      return send(res, 200, { paths });
    }
    if (req.url === '/api/git-activity' && req.method === 'POST') {
      const { paths, startDate, endDate, onlyMine = true } = await readJson(req);
      if (!Array.isArray(paths) || !paths.length) throw new Error('请至少选择一个 Git 项目。');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) throw new Error('日期格式无效。');
      log(`开始读取 Git：${paths.join(' | ')}，${startDate} 至 ${endDate}，${onlyMine ? '仅当前作者' : '所有作者'}`);
      const activities = await Promise.all(paths.map(path => scanProject(path, startDate, endDate, onlyMine)));
      log(`Git 读取完成：${activities.map(activity => `${activity.name} ${activity.commits.length} 条提交`).join(' | ')}`);
      return send(res, 200, { activities });
    }
    if (req.url === '/api/client-log' && req.method === 'POST') {
      const { message } = await readJson(req);
      log(`网页错误：${String(message || '未知错误')}`);
      return send(res, 200, { ok: true });
    }
    return false;
  } catch (error) {
    log(`请求失败：${error.message || '未知错误'}`);
    return send(res, 400, { error: error.message || '操作失败' });
  }
}

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api/')) { await handleApi(req, res); return; }
  const relative = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
  const filePath = resolve(staticRoot, relative);
  if (!filePath.startsWith(staticRoot) || relative.includes('..')) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    const content = await readFile(filePath);
    send(res, 200, content, mimeTypes[extname(filePath)] || 'application/octet-stream');
  } catch { send(res, 404, 'Not found', 'text/plain'); }
});

server.listen(port, '127.0.0.1', () => console.log(`日报引擎已启动：http://127.0.0.1:${port}`));
