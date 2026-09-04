import { createServer } from 'node:http';
import { createCipheriv } from 'node:crypto';
import { appendFile, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, extname, resolve } from 'node:path';

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dirname);
const staticRoot = resolve(root, 'dist');
const port = Number(process.env.PORT || 4173);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const aiModel = process.env.OPENAI_MODEL || 'gpt-5.4';
const aiTimeoutMs = 45_000;

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

async function workingTreeChange(path) {
  const output = await git(path, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const untrackedPaths = (await git(path, ['ls-files', '--others', '--exclude-standard']))
    .split('\n').map((file) => file.trim()).filter(Boolean);
  const entries = output.split('\0');
  const files = [];
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const status = entry.slice(0, 2);
    const file = entry.slice(3).trim();
    if (status === '??') { untracked += 1; continue; }
    if (file) files.push(file);
    if (status[0] !== ' ') staged += 1;
    if (status[1] !== ' ') unstaged += 1;
    if ((status[0] === 'R' || status[0] === 'C') && entries[index + 1]) index += 1;
  }
  files.push(...untrackedPaths);
  if (!files.length) return null;
  const parts = [];
  if (staged) parts.push(`已暂存 ${staged} 个文件`);
  if (unstaged) parts.push(`未暂存 ${unstaged} 个文件`);
  if (untrackedPaths.length) untracked = untrackedPaths.length;
  if (untracked) parts.push(`新增未跟踪 ${untracked} 个文件`);
  return {
    hash: 'working-tree', author: '本地工作区', authorEmail: '', date: '',
    summary: `未提交本地变更（${parts.join('，')}）`, files: [...new Set(files)], source: 'working-tree',
    stagedFiles: staged, unstagedFiles: unstaged, untrackedFiles: untracked,
  };
}

async function scanProject(path, startDate, endDate, onlyMine, includeUncommitted = false) {
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
    return [{ hash: fields[0].trim(), author: fields[1].trim(), authorEmail: fields[3].trim(), date: fields[2].trim(), summary: fields[4].trim(), files, source: 'commit' }];
  });
  if (includeUncommitted) {
    const change = await workingTreeChange(path);
    if (change) { change.files.forEach(file => changedFiles.add(file)); commits.push(change); }
  }
  return { name: basename(path), path, branch, authorEmail, commits, changedFiles: changedFiles.size };
}

function aiSource(activities) {
  return activities.map((activity) => ({
    project: activity.name,
    branch: activity.branch,
    changes: activity.commits.map((commit) => ({
      source: commit.source || 'commit',
      date: commit.date,
      summary: commit.summary,
      files: commit.files.slice(0, 30),
    })),
  }));
}

function responseText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  return (response.output || []).flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text || '')
    .join('');
}

function aiEndpoint(baseUrl) {
  const value = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) throw new Error('Base URL 必须以 http:// 或 https:// 开头。');
  return value.endsWith('/responses') ? value : `${value}/responses`;
}

async function enhanceReportWithAi(activities, mode, baseUrl, apiKey) {
  if (!String(apiKey || '').trim()) throw new Error('请填写 AI API Key。');
  if (!Array.isArray(activities)) throw new Error('AI 分析数据格式无效。');
  const schema = {
    type: 'object', additionalProperties: false,
    properties: {
      overview: { type: 'string' },
      sections: {
        type: 'array', items: {
          type: 'object', additionalProperties: false,
          properties: {
            project: { type: 'string' },
            groups: {
              type: 'array', items: {
                type: 'object', additionalProperties: false,
                properties: { scope: { type: 'string' }, actions: { type: 'array', items: { type: 'string' } } },
                required: ['scope', 'actions'],
              },
            },
          }, required: ['project', 'groups'],
        },
      },
      footer: { type: 'string' },
    },
    required: ['overview', 'sections', 'footer'],
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), aiTimeoutMs);
  try {
    const response = await fetch(aiEndpoint(baseUrl), {
      method: 'POST', signal: controller.signal,
      headers: { authorization: `Bearer ${apiKey.trim()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: aiModel,
        input: [
          {
            role: 'system',
            content: '你是严谨的中文工作日报助手。仅依据提供的变更摘要和文件路径，按项目和业务模块整理可直接交付的工作内容，重点说明“哪个模块完成了什么事情”。不要输出或提及 Git、提交、已提交、未提交、待提交、工作区、分支、文件数量等过程信息，也不要虚构需求、业务结果、测试完成情况、进度、风险或计划。所有变更记录都按本周期完成的工作来表述，使用“完成、开发、调整、补充、优化”等交付动词；合并语义重复的变更，使用简洁、可汇报的中文。项目没有变更时不要为它生成工作项。footer 表示简短的后续安排；如果变更记录没有依据，请写“待根据业务排期和验收反馈确认后续工作。”',
          },
          { role: 'user', content: `请整理一份${mode === 'weekly' ? '周报' : '日报'}。Git 依据如下：\n${JSON.stringify(aiSource(activities))}` },
        ],
        text: { format: { type: 'json_schema', name: 'git_report', strict: true, schema } },
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error?.message || `AI 服务请求失败（${response.status}）`);
    const text = responseText(result);
    if (!text) throw new Error('AI 未返回可用的报告内容。');
    return JSON.parse(text);
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('AI 整理超时，请稍后重试。');
    if (error instanceof SyntaxError) throw new Error('AI 返回格式无效，请重试。');
    throw error;
  } finally { clearTimeout(timeout); }
}

function pmsBaseUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('工时系统地址无效。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('工时系统地址必须以 http:// 或 https:// 开头。');
  return url.origin;
}

async function pmsApi(baseUrl, path, { method = 'GET', token, tenantId, body } = {}) {
  const headers = { 'tenant-id': String(tenantId), 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(`${baseUrl}/admin-api${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  } catch { throw new Error('无法连接工时系统，请确认地址和网络。'); }
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.code !== 0) throw new Error(result.msg || `工时系统请求失败（${response.status}）`);
  return result.data;
}

function encryptPmsPassword(password, key) {
  const secret = String(key || '');
  if (Buffer.byteLength(secret, 'utf8') !== 32) throw new Error('工时系统加密配置无效。');
  const cipher = createCipheriv('aes-256-cbc', Buffer.from(secret, 'utf8'), Buffer.from(secret.slice(0, 16), 'utf8'));
  return Buffer.concat([cipher.update(String(password), 'utf8'), cipher.final()]).toString('base64');
}

async function pmsLogin(config) {
  const baseUrl = pmsBaseUrl(config.baseUrl);
  const tenantName = String(config.tenantName || '000000').trim();
  const username = String(config.username || '').trim();
  const password = String(config.password || '');
  if (!tenantName || !username || !password) throw new Error('请填写租户、账号和密码。');
  const tenantId = await pmsApi(baseUrl, `/system/tenant/get-id-by-name?name=${encodeURIComponent(tenantName)}`, { tenantId: '0' });
  if (!tenantId) throw new Error('未找到对应的工时系统租户。');
  const encryptionKey = await pmsApi(baseUrl, '/infra/config/get-value-by-key?key=sys.private.key', { tenantId });
  const session = await pmsApi(baseUrl, '/system/auth/login', {
    method: 'POST', tenantId,
    body: { tenantName, username, password: encryptPmsPassword(password, encryptionKey), captchaVerification: '', rememberMe: false },
  });
  if (!session?.accessToken) throw new Error('工时系统登录未返回访问凭证。');
  return { baseUrl, tenantId, token: session.accessToken };
}

function mondayOf(date) {
  const value = new Date(`${date}T12:00:00`);
  const weekday = value.getDay() || 7;
  value.setDate(value.getDate() - weekday + 1);
  return value.toISOString().slice(0, 10);
}

async function pmsProjects(config) {
  const session = await pmsLogin(config);
  const page = await pmsApi(session.baseUrl, '/pm/timesheet/project-page?pageNo=1&pageSize=500', session);
  return (page?.list || []).map(({ id, code, name, financeOrgName, managerName, status, statusLabel }) => ({ id, code, name, financeOrgName, managerName, status, statusLabel }));
}

async function pushPmsTimesheets(config, entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error('请至少选择一条待推送工时。');
  if (entries.length > 100) throw new Error('单次最多推送 100 条工时。');
  const session = await pmsLogin(config);
  const results = [];
  for (const entry of entries) {
    const projectId = Number(entry.projectId);
    const date = String(entry.date || '');
    const manDays = Number(entry.manDays);
    const remark = String(entry.remark || '').trim();
    if (!Number.isInteger(projectId) || projectId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(manDays) || manDays <= 0 || manDays > 31 || !remark) {
      results.push({ clientId: entry.clientId, status: 'failed', message: '项目、日期、工时和工作内容均为必填。' });
      continue;
    }
    try {
      const periodKey = mondayOf(date);
      const period = await pmsApi(session.baseUrl, `/pm/timesheet/get-period?projectId=${projectId}&viewMode=week&periodKey=${periodKey}`, session);
      if (Number(period?.entries?.[date] || 0) > 0) {
        results.push({ clientId: entry.clientId, status: 'skipped', message: '该项目当天已有已填报工时，未覆盖。' });
        continue;
      }
      const entriesByDate = { ...(period?.entries || {}), [date]: Number(manDays.toFixed(2)) };
      const contentsByDate = { ...(period?.workContents || {}), [date]: remark };
      await pmsApi(session.baseUrl, '/pm/timesheet/period', {
        method: 'POST', ...session,
        body: { projectId, viewMode: 'week', periodKey, entries: entriesByDate, workContents: contentsByDate },
      });
      results.push({ clientId: entry.clientId, status: 'submitted', message: '已推送。' });
    } catch (error) { results.push({ clientId: entry.clientId, status: 'failed', message: error.message || '推送失败。' }); }
  }
  return results;
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
      const { paths, startDate, endDate, onlyMine = true, includeUncommitted = false } = await readJson(req);
      if (!Array.isArray(paths) || !paths.length) throw new Error('请至少选择一个 Git 项目。');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) throw new Error('日期格式无效。');
      log(`开始读取 Git：${paths.join(' | ')}，${startDate} 至 ${endDate}，${onlyMine ? '仅当前作者' : '所有作者'}`);
      const activities = await Promise.all(paths.map(path => scanProject(path, startDate, endDate, onlyMine, includeUncommitted)));
      log(`Git 读取完成：${activities.map(activity => `${activity.name} ${activity.commits.length} 条提交`).join(' | ')}`);
      return send(res, 200, { activities });
    }
    if (req.url === '/api/ai-report' && req.method === 'POST') {
      const { activities, mode, baseUrl, apiKey } = await readJson(req);
      if (!['daily', 'weekly'].includes(mode)) throw new Error('报告类型无效。');
      log(`开始 AI 整理：${mode}，${activities?.length || 0} 个项目`);
      const report = await enhanceReportWithAi(activities, mode, baseUrl, apiKey);
      log('AI 整理完成');
      return send(res, 200, { report });
    }
    if (req.url === '/api/pms/projects' && req.method === 'POST') {
      const { config } = await readJson(req);
      const projects = await pmsProjects(config || {});
      return send(res, 200, { projects });
    }
    if (req.url === '/api/pms/push' && req.method === 'POST') {
      const { config, entries } = await readJson(req);
      const results = await pushPmsTimesheets(config || {}, entries);
      return send(res, 200, { results });
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
