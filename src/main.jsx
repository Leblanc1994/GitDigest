import { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog';
import {
  CalendarDays, ChevronDown, ChevronLeft, ChevronRight, Clipboard, Code2, Download, FileText,
  FolderGit2, GitCommitHorizontal, Info, LoaderCircle, Plus, RefreshCw,
  Send, ShieldCheck, Sparkles, Trash2, Users, WandSparkles, X,
} from 'lucide-react';
import './styles.css';
import './batch.css';
import './ai.css';
import './layout.css';
import './refinement.css';

function localToday() {
  const date = new Date();
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 10);
}

const today = localToday();
const scopeNames = { finance: '财务', operation: '运营', sales: '销售', purchase: '采购', auth: '权限', user: '用户', admin: '管理后台' };
const isDesktopRuntime = () => Boolean(window.__TAURI_INTERNALS__);

async function selectProjectPaths() {
  if (isDesktopRuntime()) {
    const selected = await openDirectoryDialog({ directory: true, multiple: true, title: '选择 Git 项目目录' });
    if (!selected) return [];
    return Array.isArray(selected) ? selected : [selected];
  }
  const response = await fetch('/api/select-projects', { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.paths || [];
}

async function readGitActivity(payload) {
  if (isDesktopRuntime()) return invoke('scan_git_activity', payload);
  const response = await fetch('/api/git-activity', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.activities;
}

async function enhanceReportWithAi(payload) {
  if (isDesktopRuntime()) return invoke('enhance_report_with_ai', payload);
  const response = await fetch('/api/ai-report', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result.report;
}

async function pmsRequest(path, payload) {
  if (isDesktopRuntime()) {
    const config = await prepareDesktopPmsConfig(payload.config);
    if (path === '/api/pms/projects') return invoke('pms_projects', { config });
    if (path === '/api/pms/push') return invoke('pms_push', { config, entries: payload.entries });
    throw new Error('未知的工时系统请求。');
  }
  const response = await fetch(path, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '工时系统请求失败。');
  return result;
}

async function encryptPmsPassword(password, key) {
  const bytes = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', bytes.encode(key), { name: 'AES-CBC' }, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: bytes.encode(key.slice(0, 16)) }, cryptoKey, bytes.encode(password));
  return btoa(String.fromCharCode(...new Uint8Array(encrypted)));
}

async function prepareDesktopPmsConfig(config) {
  const info = await invoke('pms_connection_info', { baseUrl: config.baseUrl, tenantName: config.tenantName });
  return { ...config, tenantId: info.tenantId, password: await encryptPmsPassword(config.password, info.encryptionKey) };
}

function dateRange(date, mode) {
  if (mode === 'daily') return { startDate: date, endDate: date };
  const current = new Date(`${date}T12:00:00`);
  const day = current.getDay() || 7;
  const monday = new Date(current); monday.setDate(current.getDate() - day + 1);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return { startDate: monday.toISOString().slice(0, 10), endDate: sunday.toISOString().slice(0, 10) };
}

function labelDate(date, mode) {
  const current = new Date(`${date}T12:00:00`);
  if (mode === 'weekly') {
    const { startDate, endDate } = dateRange(date, mode);
    return `${startDate.slice(5).replace('-', '.')} - ${endDate.slice(5).replace('-', '.')}`;
  }
  return current.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}

function dateFromIso(value) {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function isoDate(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function calendarDays(cursor) {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7;
  return Array.from({ length: 42 }, (_, index) => {
    const value = new Date(cursor.getFullYear(), cursor.getMonth(), index - offset + 1);
    return { value, iso: isoDate(value), inMonth: value.getMonth() === cursor.getMonth() };
  });
}

function isSameWeek(firstDate, secondDate) {
  return dateRange(firstDate, 'weekly').startDate === dateRange(secondDate, 'weekly').startDate;
}

function mondayOf(date) {
  const value = new Date(`${date}T12:00:00`);
  const weekday = value.getDay() || 7;
  value.setDate(value.getDate() - weekday + 1);
  return value.toISOString().slice(0, 10);
}

function parseCommit(summary, fallbackScope) {
  const match = summary.trim().match(/^(feat|fix|refactor|perf|docs|test|chore|style)(?:\(([^)]+)\))?[!:：\s]+(.+)$/i);
  const rawScope = (match?.[2] || fallbackScope || '相关功能').trim();
  return { scope: scopeNames[rawScope.toLowerCase()] || rawScope, action: (match?.[3] || summary).trim().replace(/[。；;]+$/, '') };
}

function groupedCommits(activity) {
  const groups = new Map();
  activity.commits.forEach((commit) => {
    const { scope, action } = parseCommit(commit.summary, activity.name);
    const actions = groups.get(scope) || [];
    if (!actions.includes(action)) actions.push(action);
    groups.set(scope, actions);
  });
  return [...groups.entries()].map(([scope, actions]) => ({ scope, actions }));
}

const worktreeTopics = [
  { label: '财务收款、应收与核销', pattern: /(financecollection|financereceivable|financerefundapply|financewriteoff|collectionManagement|receivableManagement|refundManagement|writeOffManagement)/i },
  { label: '财务付款流程', pattern: /(financepayable|financepaymentapplication|financepaymentexecution|advancePayment|payableBill|payment\/)/i },
  { label: '机型管理', pattern: /(machinemodel|machineModel)/i },
  { label: '销售机会与报价', pattern: /(salesapplication|salesApplication|salesQuote|opportunity)/i },
  { label: '租赁收付款', pattern: /(?:views\/rental|api\/rental|yudao-module-rental)/i },
  { label: '数据库脚本与部署文档', pattern: /(?:^doc\/|^docs\/|\.sql$|deployment)/i, action: '更新数据库脚本与部署文档' },
];

function worktreeGroups(change) {
  const files = change.files || [];
  const topics = new Map();
  const uncategorized = [];
  files.forEach((file) => {
    const normalized = file.replace(/\\/g, '/');
    const topic = worktreeTopics.find((item) => item.pattern.test(normalized));
    if (topic) topics.set(topic.label, (topics.get(topic.label) || 0) + 1);
    else uncategorized.push(normalized);
  });
  const sourceKinds = new Set(files.map((file) => file.split('.').pop()?.toLowerCase()));
  const delivery = sourceKinds.has('java') ? '接口、数据模型、服务与测试' : sourceKinds.has('vue') || sourceKinds.has('ts') ? '页面、表单、接口与测试' : '相关文件';
  const groups = [...topics.entries()].sort((first, second) => second[1] - first[1])
    .map(([scope, count]) => {
      const topic = worktreeTopics.find((item) => item.label === scope);
      return { scope, actions: [`${topic?.action || `调整${delivery}`}（${count} 个文件，待提交）`] };
    });
  if (uncategorized.length) {
    const directories = [...new Set(uncategorized.map((file) => file.split('/').slice(0, 2).join('/')).filter(Boolean))].slice(0, 3);
    groups.push({ scope: '其他改动', actions: [`涉及 ${uncategorized.length} 个文件${directories.length ? `（${directories.join('、')}）` : ''}，待提交`] });
  }
  return groups.length ? groups : [{ scope: '本地工作区', actions: [`涉及 ${files.length} 个文件，待提交`] }];
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function validAiGroups(groups) {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group) => {
    const scope = String(group?.scope || '').trim();
    const actions = Array.isArray(group?.actions) ? group.actions.map((action) => String(action).trim()).filter(Boolean) : [];
    return scope && actions.length ? [{ scope, actions }] : [];
  });
}

function makeReport(activities, mode, aiContent = null) {
  const commits = activities.reduce((total, activity) => total + activity.commits.filter((commit) => commit.source !== 'working-tree').length, 0);
  const uncommitted = activities.reduce((total, activity) => total + activity.commits.filter((commit) => commit.source === 'working-tree').length, 0);
  const files = activities.reduce((total, activity) => total + activity.changedFiles, 0);
  const modules = [...new Set(activities.flatMap((activity) => groupedCommits(activity).map((group) => group.scope)))];
  const changeSummary = [`${commits} 条 Git 提交`, uncommitted ? `${uncommitted} 项待提交本地变更` : ''].filter(Boolean).join('，');
  const defaultOverview = `本${mode === 'daily' ? '日' : '周'}识别到 ${changeSummary}，涉及 ${files} 个文件变更。`;
  const defaultFooter = mode === 'daily'
    ? '结合测试与业务验收反馈，确认上述功能的边界场景和后续优化项。'
    : '推进已完成需求的联调、测试与验收，跟进业务反馈并处理遗留问题。';
  const aiSections = new Map((Array.isArray(aiContent?.sections) ? aiContent.sections : [])
    .map((section) => [String(section?.project || '').trim(), validAiGroups(section?.groups)]));
  const sections = activities.flatMap((activity) => {
    const committed = activity.commits.filter((commit) => commit.source !== 'working-tree');
    const worktree = activity.commits.filter((commit) => commit.source === 'working-tree');
    const committedActivity = { ...activity, commits: committed };
    const result = [];
    if (committed.length) result.push({ project: activity.name, label: mode === 'daily' ? '今日完成' : '本周完成', groups: aiSections.get(activity.name)?.length ? aiSections.get(activity.name) : groupedCommits(committedActivity) });
    if (worktree.length) result.push({ project: activity.name, label: '待提交改动', groups: worktree.flatMap(worktreeGroups) });
    if (!result.length) result.push({ project: activity.name, label: mode === 'daily' ? '今日完成' : '本周完成', groups: [] });
    return result;
  });
  const overview = String(aiContent?.overview || '').trim() || defaultOverview;
  const footer = String(aiContent?.footer || '').trim() || defaultFooter;
  const html = [
    `<section><h2>工作概览</h2><p>${escapeHtml(overview)}</p></section>`,
    ...sections.map((section) => `<section><h2>${escapeHtml(section.project)} · ${escapeHtml(section.label)}</h2><ul>${section.groups.length ? section.groups.map((group) => `<li><strong>${escapeHtml(group.scope)}</strong><span>${group.actions.map(escapeHtml).join('；')}。</span></li>`).join('') : '<li>该时间范围内没有新的 Git 提交。</li>'}</ul></section>`),
    `<section><h2>${mode === 'daily' ? '待跟进' : '下周计划'}</h2><p>${escapeHtml(footer)}</p></section>`,
  ].join('');
  return { commits, uncommitted, files, overview, sections, footer, html };
}

function defaultWorkContent(section) {
  const items = (section.groups || []).flatMap((group) => group.actions?.length
    ? [`${group.scope}：${group.actions.join('；')}`] : []);
  return items.join('；').slice(0, 1000);
}

function makePmsRows(bundle) {
  return (bundle?.report?.sections || []).map((section, index) => ({
    clientId: `${bundle.date}-${index}-${section.project}`,
    sourceProject: section.project,
    projectId: '',
    manDays: '',
    remark: defaultWorkContent(section),
    selected: true,
  }));
}

function IconButton({ label, children, ...props }) {
  return <button className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
}

function App() {
  const [projects, setProjects] = useState([]);
  const [mode, setMode] = useState('daily');
  const [date, setDate] = useState(today);
  const [dailyDates, setDailyDates] = useState([today]);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarCursor, setCalendarCursor] = useState(dateFromIso(today));
  const [pendingDates, setPendingDates] = useState([today]);
  const [weekOpen, setWeekOpen] = useState(false);
  const [weekCursor, setWeekCursor] = useState(dateFromIso(today));
  const [pendingWeek, setPendingWeek] = useState(today);
  const [onlyMine, setOnlyMine] = useState(true);
  const [aiEnabled, setAiEnabled] = useState(true);
  const [aiConfigOpen, setAiConfigOpen] = useState(false);
  const [aiBaseUrl, setAiBaseUrl] = useState('https://api.openai.com/v1');
  const [aiApiKey, setAiApiKey] = useState('');
  const [reports, setReports] = useState([]);
  const [activeReportDate, setActiveReportDate] = useState(today);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
  const [pmsOpen, setPmsOpen] = useState(false);
  const [pmsLoading, setPmsLoading] = useState(false);
  const [pmsSubmitting, setPmsSubmitting] = useState(false);
  const [pmsProjects, setPmsProjects] = useState([]);
  const [pmsRows, setPmsRows] = useState([]);
  const [pmsResults, setPmsResults] = useState([]);
  const [pmsConfig, setPmsConfig] = useState({ baseUrl: 'http://192.168.24.48:8081', tenantName: '000000', username: '', password: '' });
  const reportRef = useRef(null);
  const range = useMemo(() => dateRange(date, mode), [date, mode]);
  const activeBundle = reports.find((bundle) => bundle.date === activeReportDate) || null;
  const report = activeBundle?.report || null;
  const activities = activeBundle?.activities || [];

  function flash(message) {
    setNotice(message);
    window.clearTimeout(window.dailyEngineNotice);
    window.dailyEngineNotice = window.setTimeout(() => setNotice(''), 2600);
  }

  async function addProjects() {
    try {
      const paths = await selectProjectPaths();
      const additions = paths.filter((path) => !projects.some((project) => project.path === path))
        .map((path) => ({ name: path.split(/[\\/]/).filter(Boolean).pop(), path }));
      setProjects((current) => [...current, ...additions]);
      if (paths.length) flash(additions.length ? `已添加 ${additions.length} 个项目` : '项目已在列表中');
    } catch (error) { flash(`无法打开项目目录：${error.message}`); }
  }

  function removeProject(path) {
    setProjects((current) => current.filter((project) => project.path !== path));
  }

  function openCalendar() {
    setPendingDates(dailyDates);
    setCalendarCursor(dateFromIso(dailyDates.at(-1) || date));
    setCalendarOpen(true);
  }

  function togglePendingDate(value) {
    setPendingDates((current) => current.includes(value) ? current.filter((item) => item !== value) : [...current, value].sort());
  }

  function confirmDates() {
    if (!pendingDates.length) { flash('请至少选择一个日期'); return; }
    setDailyDates(pendingDates);
    setCalendarOpen(false);
  }

  function openWeekCalendar() {
    setPendingWeek(date);
    setWeekCursor(dateFromIso(date));
    setWeekOpen(true);
  }

  function confirmWeek() {
    setDate(pendingWeek);
    setWeekOpen(false);
  }

  async function generate() {
    if (!projects.length) { flash('请先添加至少一个 Git 项目'); return; }
    const reportDates = mode === 'daily' ? dailyDates : [date];
    if (!reportDates.length) { flash('请至少添加一个日报日期'); return; }
    // AI is an optional enhancement. A local Git-based draft is always available.
    const useAi = aiEnabled && Boolean(aiBaseUrl.trim() && aiApiKey.trim());
    setLoading(true);
    try {
      const bundles = await Promise.all(reportDates.map(async (reportDate) => {
        try {
          const activities = await readGitActivity({ paths: projects.map((project) => project.path), ...dateRange(reportDate, mode), onlyMine, includeUncommitted: mode === 'daily' && reportDate === today });
          let report = makeReport(activities, mode);
          let aiError = '';
          if (useAi && activities.some((activity) => activity.commits.length)) {
            try {
              const aiContent = await enhanceReportWithAi({ activities, mode, baseUrl: aiBaseUrl, apiKey: aiApiKey });
              report = makeReport(activities, mode, aiContent);
            } catch (error) { aiError = error.message || String(error); }
          }
          return { date: reportDate, activities, report, aiError };
        } catch (error) {
          throw new Error(`${reportDate}：${error.message || String(error)}`);
        }
      }));
      setReports(bundles);
      setActiveReportDate(bundles[0].date);
      const aiErrors = bundles.filter((bundle) => bundle.aiError);
      if (aiErrors.length) flash(`已生成 Git 初稿；AI 未完成：${aiErrors[0].aiError}`);
      else if (mode === 'daily' && bundles.length > 1) flash(`已生成 ${bundles.length} 份日报`);
      else if (useAi) flash('AI 报告已更新');
      else if (aiEnabled) flash('已生成 Git 初稿；配置 AI 后可自动润色');
      else flash('报告已更新');
    } catch (error) { flash(`读取 Git 失败：${error.message}`); }
    finally { setLoading(false); }
  }

  function reportText() {
    return reportRef.current?.innerText.trim() || '';
  }

  async function copyReport() {
    await navigator.clipboard.writeText(reportText());
    flash('报告已复制');
  }

  function exportReport() {
    const exportDate = activeBundle?.date || date;
    const exportRange = dateRange(exportDate, mode);
    const title = mode === 'daily' ? `${exportDate} 日报` : `${exportRange.startDate} 至 ${exportRange.endDate} 周报`;
    const blob = new Blob([`${title}\n\n${reportText()}`], { type: 'text/markdown;charset=utf-8' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${title}.md`; link.click(); URL.revokeObjectURL(link.href);
    flash('Markdown 已导出');
  }

  function openPmsPreview() {
    if (!activeBundle || mode !== 'daily') { flash('请先生成一份日报。'); return; }
    setPmsRows(makePmsRows(activeBundle));
    setPmsResults([]);
    setPmsOpen(true);
  }

  function updatePmsRow(clientId, patch) {
    setPmsRows((rows) => rows.map((row) => row.clientId === clientId ? { ...row, ...patch } : row));
  }

  async function loadPmsProjects() {
    setPmsLoading(true);
    setPmsResults([]);
    try {
      const { projects: availableProjects } = await pmsRequest('/api/pms/projects', { config: pmsConfig });
      setPmsProjects(availableProjects || []);
      flash(`已读取 ${availableProjects?.length || 0} 个可填报项目`);
    } catch (error) { flash(`无法读取工时项目：${error.message}`); }
    finally { setPmsLoading(false); }
  }

  async function submitPmsRows() {
    const rows = pmsRows.filter((row) => row.selected);
    if (!rows.length) { flash('请至少选择一条工时。'); return; }
    const invalid = rows.some((row) => !row.projectId || !Number(row.manDays) || !row.remark.trim());
    if (invalid) { flash('已选工时需要补全项目、工时和工作内容。'); return; }
    setPmsSubmitting(true);
    try {
      const { results } = await pmsRequest('/api/pms/push', {
        config: pmsConfig,
        entries: rows.map((row) => ({ ...row, date: activeBundle.date, periodKey: mondayOf(activeBundle.date) })),
      });
      setPmsResults(results || []);
      const success = (results || []).filter((item) => item.status === 'submitted').length;
      const skipped = (results || []).filter((item) => item.status === 'skipped').length;
      flash(`推送完成：${success} 条成功${skipped ? `，${skipped} 条未覆盖` : ''}`);
    } catch (error) { flash(`工时推送失败：${error.message}`); }
    finally { setPmsSubmitting(false); }
  }

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><Sparkles size={15} /></span><span>日报引擎</span></div>
      <div className="header-status"><ShieldCheck size={14} /> 本地处理，数据不上传</div>
      <div className="header-actions"><span className="quiet-label">{projects.length} 个项目</span><IconButton label="刷新当前报告" onClick={generate}><RefreshCw size={16} /></IconButton></div>
    </header>

    <div className="workspace">
      <aside className="sidebar">
        <div className="project-list">
          {projects.length === 0 && <div className="empty-projects"><span className="empty-project-icon"><FolderGit2 size={18} /></span><strong>还没有项目</strong><span className="empty-project-copy">添加本地 Git 项目后开始生成日报。</span><button className="empty-project-action" onClick={addProjects}><Plus size={14} />添加项目</button></div>}
          {projects.map((project) => <div className="project-row" key={project.path}>
            <FolderGit2 size={16} /><div className="project-copy"><strong>{project.name}</strong><span>{project.path}</span></div>
            <IconButton label={`移除 ${project.name}`} onClick={() => removeProject(project.path)}><Trash2 size={14} /></IconButton>
          </div>)}
        </div>
        {projects.length > 0 && <button className="project-list-add" onClick={addProjects}><Plus size={14} />添加项目</button>}
        <div className="sidebar-bottom"><Info size={14} /><span>支持选择多个仓库一起生成。</span></div>
      </aside>

      <main className="report-workspace">
        <div className="control-area">
        <div className="control-bar">
          <div className="mode-switch" aria-label="报告类型">
            <button className={mode === 'daily' ? 'active' : ''} onClick={() => setMode('daily')}>日报</button>
            <button className={mode === 'weekly' ? 'active' : ''} onClick={() => setMode('weekly')}>周报</button>
          </div>
          {mode === 'daily' ? <div className="date-multi">
            <button className="date-picker-button" onClick={openCalendar} aria-expanded={calendarOpen}><CalendarDays size={15} /><span>{dailyDates.length === 1 ? dailyDates[0].slice(5).replace('-', '.') : `已选 ${dailyDates.length} 天`}</span><ChevronDown size={14} /></button>
            {calendarOpen && <div className="multi-calendar" role="dialog" aria-label="选择多个日报日期">
              <div className="calendar-top"><button aria-label="上个月" onClick={() => setCalendarCursor((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}><ChevronLeft size={15} /></button><strong>{calendarCursor.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })}</strong><button aria-label="下个月" onClick={() => setCalendarCursor((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}><ChevronRight size={15} /></button></div>
              <div className="calendar-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}</div>
              <div className="calendar-grid">{calendarDays(calendarCursor).map((item) => <button key={item.iso} disabled={item.iso > today} className={`${item.inMonth ? '' : 'outside'} ${pendingDates.includes(item.iso) ? 'selected' : ''} ${item.iso === today ? 'today' : ''}`} onClick={() => togglePendingDate(item.iso)}>{item.value.getDate()}</button>)}</div>
              <div className="calendar-footer"><span>已选择 {pendingDates.length} 天</span><div><button onClick={() => setCalendarOpen(false)}>取消</button><button className="calendar-confirm" onClick={confirmDates}>确认日期</button></div></div>
            </div>}
          </div> : <div className="date-multi">
            <button className="date-picker-button" onClick={openWeekCalendar} aria-expanded={weekOpen}><CalendarDays size={15} /><span>{labelDate(date, 'weekly')}</span><ChevronDown size={14} /></button>
            {weekOpen && <div className="multi-calendar week-calendar" role="dialog" aria-label="选择周报所在周">
              <div className="calendar-top"><button aria-label="上个月" onClick={() => setWeekCursor((current) => new Date(current.getFullYear(), current.getMonth() - 1, 1))}><ChevronLeft size={15} /></button><strong>{weekCursor.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })}</strong><button aria-label="下个月" onClick={() => setWeekCursor((current) => new Date(current.getFullYear(), current.getMonth() + 1, 1))}><ChevronRight size={15} /></button></div>
              <p className="calendar-tip">点击任意日期，自动选择所在周</p>
              <div className="calendar-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>{day}</span>)}</div>
              <div className="calendar-grid">{calendarDays(weekCursor).map((item) => <button key={item.iso} disabled={item.iso > today} className={`${item.inMonth ? '' : 'outside'} ${isSameWeek(item.iso, pendingWeek) ? 'week-selected' : ''} ${item.iso === pendingWeek ? 'week-anchor' : ''} ${item.iso === today ? 'today' : ''}`} onClick={() => setPendingWeek(item.iso)}>{item.value.getDate()}</button>)}</div>
              <div className="calendar-footer"><span>{labelDate(pendingWeek, 'weekly')}</span><div><button onClick={() => setWeekOpen(false)}>取消</button><button className="calendar-confirm" onClick={confirmWeek}>确认本周</button></div></div>
            </div>}
          </div>}
          <label className="checkbox-control"><input type="checkbox" checked={onlyMine} onChange={(event) => setOnlyMine(event.target.checked)} /><span aria-hidden="true" />只统计我的提交</label>
          <label className="checkbox-control ai-control"><input type="checkbox" checked={aiEnabled} onChange={(event) => setAiEnabled(event.target.checked)} /><span aria-hidden="true" /><WandSparkles size={13} />AI 润色（可选）</label>
          <button className="ai-settings-button" type="button" onClick={() => setAiConfigOpen((open) => !open)} aria-expanded={aiConfigOpen}>AI 设置</button>
          {aiEnabled && !aiConfigOpen && <span className={`ai-config-state ${aiApiKey.trim() ? 'ready' : ''}`}>{aiApiKey.trim() ? 'AI 已配置' : '未配置，使用本地汇总'}</span>}
          <button className="generate-button" onClick={generate} disabled={!projects.length || loading} title={!projects.length ? '请先添加项目' : undefined}>{loading ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{loading ? '读取并整理中' : !projects.length ? '添加项目后生成' : '生成报告'}</button>
        </div>
        {aiEnabled && aiConfigOpen && <div className="ai-settings" role="group" aria-label="AI 设置">
          <div className="ai-settings-heading"><span className="ai-settings-mark">AI</span><div><strong>AI 润色（可选）</strong><span>未配置时仍会生成本地 Git 初稿</span></div></div>
          <div className="ai-settings-fields">
            <label><span>Base URL</span><input value={aiBaseUrl} onChange={(event) => setAiBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" spellCheck="false" /></label>
            <label><span>API Key</span><input type="password" value={aiApiKey} onChange={(event) => setAiApiKey(event.target.value)} placeholder="输入 API Key" autoComplete="off" spellCheck="false" /></label>
          </div>
          <div className="ai-security-note"><ShieldCheck size={14} /><span>仅用于当前会话<br />不会保存到本机</span></div>
        </div>}
        </div>

        <section className="document-sheet">
          <div className="document-toolbar">
            <div><p className="document-label">{mode === 'daily' ? 'DAILY REPORT' : 'WEEKLY REPORT'}</p><h1>{mode === 'daily' ? '工作日报' : '工作周报'}</h1><p className="document-date">{labelDate(activeBundle?.date || date, mode)}</p></div>
            <div className="export-actions"><IconButton label="复制报告" onClick={copyReport} disabled={!report}><Clipboard size={16} /></IconButton><button className="secondary-button" onClick={exportReport} disabled={!report}><Download size={15} />导出 Markdown</button>{mode === 'daily' && <button className="pms-open-button" onClick={openPmsPreview} disabled={!report}><Send size={15} />推送工时</button>}</div>
          </div>
          {mode === 'daily' && reports.length > 1 && <div className="report-tabs" role="tablist">{reports.map((bundle) => <button role="tab" aria-selected={activeReportDate === bundle.date} className={activeReportDate === bundle.date ? 'active' : ''} key={bundle.date} onClick={() => setActiveReportDate(bundle.date)}>{labelDate(bundle.date, 'daily')}</button>)}</div>}
          {report ? <article className="report-content" ref={reportRef} contentEditable suppressContentEditableWarning dangerouslySetInnerHTML={{ __html: report.html }} onInput={(event) => setReports((current) => current.map((bundle) => bundle.date === activeReportDate ? { ...bundle, report: { ...bundle.report, html: event.currentTarget.innerHTML } } : bundle))} /> : <div className="report-empty"><span className="report-empty-icon"><FileText size={30} /></span><h2>{projects.length ? '准备一份新的工作报告' : '先添加一个项目'}</h2><p>{projects.length ? '确认日期和提交范围后，生成一份可编辑的日报。' : '日报引擎只读取本机 Git 数据，不会上传你的代码。'}</p><div className="empty-steps"><span><b>1</b> 添加项目</span><span><b>2</b> 选择日期</span><span><b>3</b> 生成报告</span></div><button onClick={projects.length ? generate : addProjects}><Sparkles size={15} />{projects.length ? '生成报告' : '添加项目'}</button></div>}
          <footer className="document-footer"><span><ShieldCheck size={13} /> 仅基于本地 Git 数据</span>{report && <span>{report.commits} 条提交{report.uncommitted ? ` · ${report.uncommitted} 项未提交变更` : ''} · {report.files} 个文件变更</span>}</footer>
        </section>
      </main>

      <aside className="source-panel">
        <div className="panel-heading"><span>变更依据</span><span className="source-count">{activities.reduce((total, activity) => total + activity.commits.length, 0)}</span></div>
        {!report && <div className="source-empty"><Code2 size={20} /><p>{projects.length ? '生成报告后，这里会保留对应的 Git 变更依据。' : '选择项目后，这里会显示 Git 变更依据。'}</p></div>}
        {activities.map((activity) => <div className="source-project" key={activity.path}><div className="source-project-name"><FolderGit2 size={14} />{activity.name}<span>{activity.branch}</span></div>{activity.commits.map((commit) => <details className="commit-row" key={commit.hash}><summary><GitCommitHorizontal size={14} /><span>{commit.summary}</span>{commit.source === 'working-tree' && <em className="working-tree-badge">未提交</em>}<ChevronDown size={14} /></summary><div className="commit-detail"><span>{commit.source === 'working-tree' ? '当前本地工作区' : `${commit.author} · ${commit.date}`}</span><span>{commit.files.length} 个文件变更</span></div></details>)}</div>)}
        {report && <div className="source-note"><Users size={14} />{onlyMine ? '已按当前 Git 身份过滤；当天会额外读取未提交本地变更' : '已包含所有作者提交；当天会额外读取未提交本地变更'}</div>}
      </aside>
    </div>
    {pmsOpen && <div className="pms-overlay" role="presentation">
      <section className="pms-dialog" role="dialog" aria-modal="true" aria-label="推送工时预览">
        <header className="pms-dialog-header"><div><p>WORKLOG DELIVERY</p><h2>推送工时预览</h2><span>{activeBundle?.date} · 请确认每条日报与工时系统项目的对应关系</span></div><button className="pms-close" aria-label="关闭" onClick={() => setPmsOpen(false)}><X size={18} /></button></header>
        <div className="pms-connection">
          <div className="pms-connection-copy"><strong>连接工时系统</strong><span>账号密码仅用于本次读取和推送，不会保存。</span></div>
          <label><span>地址</span><input value={pmsConfig.baseUrl} onChange={(event) => setPmsConfig((value) => ({ ...value, baseUrl: event.target.value }))} placeholder="http://服务器地址:端口" /></label>
          <label><span>租户</span><input value={pmsConfig.tenantName} onChange={(event) => setPmsConfig((value) => ({ ...value, tenantName: event.target.value }))} /></label>
          <label><span>账号</span><input value={pmsConfig.username} onChange={(event) => setPmsConfig((value) => ({ ...value, username: event.target.value }))} autoComplete="username" /></label>
          <label><span>密码</span><input type="password" value={pmsConfig.password} onChange={(event) => setPmsConfig((value) => ({ ...value, password: event.target.value }))} autoComplete="current-password" /></label>
          <button className="pms-load-button" onClick={loadPmsProjects} disabled={pmsLoading}>{pmsLoading ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}{pmsProjects.length ? '刷新项目' : '读取项目'}</button>
        </div>
        <div className="pms-preview-heading"><div><strong>待推送清单</strong><span>日报正文可继续编辑；推送前请在此确认项目、工时与工作内容。</span></div><span>{pmsRows.filter((row) => row.selected).length} 条已选</span></div>
        <div className="pms-table-wrap"><table className="pms-table"><thead><tr><th>推送</th><th>日报项目</th><th>工时系统项目</th><th>工时（天）</th><th>工作内容</th><th>结果</th></tr></thead><tbody>{pmsRows.map((row) => {
          const result = pmsResults.find((item) => item.clientId === row.clientId);
          return <tr key={row.clientId}><td><input aria-label={`选择 ${row.sourceProject}`} type="checkbox" checked={row.selected} onChange={(event) => updatePmsRow(row.clientId, { selected: event.target.checked })} /></td><td><strong>{row.sourceProject}</strong></td><td><select aria-label={`${row.sourceProject} 对应项目`} value={row.projectId} onChange={(event) => updatePmsRow(row.clientId, { projectId: event.target.value })}><option value="">选择工时项目</option>{pmsProjects.map((project) => <option key={project.id} value={project.id}>{project.name} · {project.code}</option>)}</select></td><td><input aria-label={`${row.sourceProject} 工时`} className="pms-days" type="number" min="0" max="31" step="0.01" value={row.manDays} onChange={(event) => updatePmsRow(row.clientId, { manDays: event.target.value })} placeholder="0.00" /></td><td><textarea aria-label={`${row.sourceProject} 工作内容`} value={row.remark} maxLength="1000" onChange={(event) => updatePmsRow(row.clientId, { remark: event.target.value })} /></td><td>{result && <span className={`pms-result ${result.status}`}>{result.message}</span>}</td></tr>;
        })}</tbody></table></div>
        <footer className="pms-dialog-footer"><span><ShieldCheck size={14} /> 点击推送后才会写入工时系统；已有工时不会被覆盖。</span><div><button className="pms-cancel" onClick={() => setPmsOpen(false)}>稍后处理</button><button className="pms-submit" onClick={submitPmsRows} disabled={pmsSubmitting || !pmsProjects.length}>{pmsSubmitting ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}{pmsSubmitting ? '正在推送' : '确认并推送'}</button></div></footer>
      </section>
    </div>}
    {notice && <div className="toast">{notice}</div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
