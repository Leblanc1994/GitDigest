import { useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { invoke } from '@tauri-apps/api/core';
import { open as openDirectoryDialog } from '@tauri-apps/plugin-dialog';
import {
  CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Clipboard, Code2, Download, FileText,
  FolderGit2, GitCommitHorizontal, Info, LoaderCircle, Plus, RefreshCw,
  ShieldCheck, Sparkles, Trash2, Users,
} from 'lucide-react';
import './styles.css';
import './batch.css';

const today = new Date().toISOString().slice(0, 10);
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
  return current.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' });
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

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

function makeReport(activities, mode) {
  const commits = activities.reduce((total, activity) => total + activity.commits.length, 0);
  const files = activities.reduce((total, activity) => total + activity.changedFiles, 0);
  const modules = [...new Set(activities.flatMap((activity) => groupedCommits(activity).map((group) => group.scope)))];
  const overview = `本${mode === 'daily' ? '日' : '周'}完成 ${commits} 项功能迭代，覆盖${modules.length ? ` ${modules.join('、')} 等` : ''}业务模块，涉及 ${files} 个文件变更。`;
  const sections = activities.map((activity) => ({ project: activity.name, groups: groupedCommits(activity) }));
  const footer = mode === 'daily'
    ? '结合测试与业务验收反馈，确认上述功能的边界场景和后续优化项。'
    : '推进已完成需求的联调、测试与验收，跟进业务反馈并处理遗留问题。';
  const html = [
    `<section><h2>工作概览</h2><p>${escapeHtml(overview)}</p></section>`,
    ...sections.map((section) => `<section><h2>${escapeHtml(section.project)} · ${mode === 'daily' ? '今日完成' : '本周完成'}</h2><ul>${section.groups.length ? section.groups.map((group) => `<li><strong>${escapeHtml(group.scope)}</strong><span>${group.actions.map(escapeHtml).join('；')}。</span></li>`).join('') : '<li>该时间范围内没有新的 Git 提交。</li>'}</ul></section>`),
    `<section><h2>${mode === 'daily' ? '待跟进' : '下周计划'}</h2><p>${escapeHtml(footer)}</p></section>`,
  ].join('');
  return { commits, files, overview, sections, footer, html };
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
  const [reports, setReports] = useState([]);
  const [activeReportDate, setActiveReportDate] = useState(today);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState('');
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
    setLoading(true);
    try {
      const bundles = await Promise.all(reportDates.map(async (reportDate) => {
        try {
          const activities = await readGitActivity({ paths: projects.map((project) => project.path), ...dateRange(reportDate, mode), onlyMine });
          return { date: reportDate, activities, report: makeReport(activities, mode) };
        } catch (error) {
          throw new Error(`${reportDate}：${error.message || String(error)}`);
        }
      }));
      setReports(bundles);
      setActiveReportDate(bundles[0].date);
      flash(mode === 'daily' && bundles.length > 1 ? `已生成 ${bundles.length} 份日报` : '报告已更新');
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

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><span className="brand-mark"><Sparkles size={15} /></span><span>日报引擎</span></div>
      <div className="header-status"><ShieldCheck size={14} /> 本地处理，数据不上传</div>
      <div className="header-actions"><span className="quiet-label">{projects.length} 个项目</span><IconButton label="刷新当前报告" onClick={generate}><RefreshCw size={16} /></IconButton></div>
    </header>

    <div className="workspace">
      <aside className="sidebar">
        <div className="panel-heading"><span>项目</span><button className="plain-add" onClick={addProjects}><Plus size={15} /> 添加</button></div>
        <p className="panel-note">选择要汇总的本地 Git 项目。</p>
        <div className="project-list">
          {projects.length === 0 && <div className="empty-projects"><FolderGit2 size={18} /><span>还没有项目</span><button onClick={addProjects}>选择项目目录</button></div>}
          {projects.map((project) => <div className="project-row" key={project.path}>
            <FolderGit2 size={16} /><div className="project-copy"><strong>{project.name}</strong><span>{project.path}</span></div>
            <IconButton label={`移除 ${project.name}`} onClick={() => removeProject(project.path)}><Trash2 size={14} /></IconButton>
          </div>)}
        </div>
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
          <label className="checkbox-control"><input type="checkbox" checked={onlyMine} onChange={(event) => setOnlyMine(event.target.checked)} /><span><Check size={12} /></span>只统计我的提交</label>
          <button className="generate-button" onClick={generate} disabled={loading}>{loading ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={16} />}{loading ? '读取 Git 中' : '生成报告'}</button>
        </div>
        </div>

        <section className="document-sheet">
          <div className="document-toolbar">
            <div><p className="document-label">{mode === 'daily' ? 'DAILY REPORT' : 'WEEKLY REPORT'}</p><h1>{mode === 'daily' ? '工作日报' : '工作周报'}</h1><p className="document-date">{labelDate(activeBundle?.date || date, mode)}</p></div>
            <div className="export-actions"><IconButton label="复制报告" onClick={copyReport} disabled={!report}><Clipboard size={16} /></IconButton><button className="secondary-button" onClick={exportReport} disabled={!report}><Download size={15} />导出 Markdown</button></div>
          </div>
          {mode === 'daily' && reports.length > 1 && <div className="report-tabs" role="tablist">{reports.map((bundle) => <button role="tab" aria-selected={activeReportDate === bundle.date} className={activeReportDate === bundle.date ? 'active' : ''} key={bundle.date} onClick={() => setActiveReportDate(bundle.date)}>{labelDate(bundle.date, 'daily')}</button>)}</div>}
          {report ? <article className="report-content" ref={reportRef} contentEditable suppressContentEditableWarning dangerouslySetInnerHTML={{ __html: report.html }} onInput={(event) => setReports((current) => current.map((bundle) => bundle.date === activeReportDate ? { ...bundle, report: { ...bundle.report, html: event.currentTarget.innerHTML } } : bundle))} /> : <div className="report-empty"><FileText size={30} /><h2>准备一份新的工作报告</h2><p>选择项目和日期后，报告会根据你的 Git 提交生成。</p><button onClick={generate}><Sparkles size={15} />生成报告</button></div>}
          <footer className="document-footer"><span><ShieldCheck size={13} /> 仅基于本地 Git 数据</span>{report && <span>{report.commits} 条提交 · {report.files} 个文件变更</span>}</footer>
        </section>
      </main>

      <aside className="source-panel">
        <div className="panel-heading"><span>提交依据</span><span className="source-count">{activities.reduce((total, activity) => total + activity.commits.length, 0)}</span></div>
        {!report && <div className="source-empty"><Code2 size={20} /><p>生成报告后，这里会保留对应的 Git 提交依据。</p></div>}
        {activities.map((activity) => <div className="source-project" key={activity.path}><div className="source-project-name"><FolderGit2 size={14} />{activity.name}<span>{activity.branch}</span></div>{activity.commits.map((commit) => <details className="commit-row" key={commit.hash}><summary><GitCommitHorizontal size={14} /><span>{commit.summary}</span><ChevronDown size={14} /></summary><div className="commit-detail"><span>{commit.author} · {commit.date}</span><span>{commit.files.length} 个文件变更</span></div></details>)}</div>)}
        {report && <div className="source-note"><Users size={14} />{onlyMine ? '已按当前 Git 身份过滤' : '已包含所有作者的提交'}</div>}
      </aside>
    </div>
    {notice && <div className="toast">{notice}</div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
