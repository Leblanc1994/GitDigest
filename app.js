const projects = [];
let mode = 'daily';
const $ = (s) => document.querySelector(s);
const date = $('#report-date');
date.value = new Date().toISOString().slice(0, 10);

function updateDateHint() {
  const d = new Date(`${date.value}T12:00:00`);
  if (mode === 'weekly') {
    const day = d.getDay() || 7;
    const monday = new Date(d); monday.setDate(d.getDate() - day + 1);
    const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
    $('#date-label').textContent = '所在周';
    $('#date-hint').textContent = `${fmt(monday)} — ${fmt(sunday)}`;
  } else {
    $('#date-label').textContent = '汇报日期';
    $('#date-hint').textContent = d.toLocaleDateString('zh-CN', { weekday: 'long' });
  }
}
function fmt(d) { return `${d.getMonth() + 1} 月 ${d.getDate()} 日`; }
function renderProjects() {
  const list = $('#project-list');
  $('#project-count').textContent = projects.length;
  list.innerHTML = projects.length ? projects.map((p, i) => `<div class="project"><i class="project-dot"></i><div><div class="project-name">${p.name}</div><div class="project-path">${p.path}</div></div><button class="remove" data-index="${i}" aria-label="移除项目">×</button></div>`).join('') : '<div class="empty-projects">还没有选择项目<br /><small>可添加多个目录一起生成</small></div>';
  document.querySelectorAll('.remove').forEach(b => b.onclick = () => { projects.splice(+b.dataset.index, 1); renderProjects(); });
}
function addPaths(paths) {
  const newPaths = paths.map(path => path.trim()).filter(Boolean).filter(path => !projects.some(project => project.path === path));
  newPaths.forEach(path => projects.push({ name: path.split('/').filter(Boolean).pop(), path, commits: 0, files: 0 }));
  renderProjects();
  return newPaths.length;
}
async function addProject() {
  const button = $('#add-project');
  const originalLabel = button.innerHTML;
  button.disabled = true; button.innerHTML = '<span>…</span> 正在打开目录选择窗口';
  try {
    const response = await fetch('/api/select-projects', { method: 'POST' });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const paths = result.paths || [];
    if (!paths.length) { toast('没有选择项目目录'); return; }
    const added = addPaths(paths);
    toast(added ? `已添加 ${added} 个项目` : '这些项目已经在列表中');
  } catch (error) {
    console.error('打开项目目录失败：', error);
    toast(`无法打开目录选择：${error.message || String(error)}`);
  } finally {
    button.disabled = false; button.innerHTML = originalLabel;
  }
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function parseCommit(summary, fallbackScope) {
  const match = summary.trim().match(/^(feat|fix|refactor|perf|docs|test|chore|style)(?:\(([^)]+)\))?[!:：\s]+(.+)$/i);
  const scopeNames = { finance: '财务', operation: '运营', sales: '销售', purchase: '采购', auth: '权限', user: '用户', admin: '管理后台' };
  const rawScope = (match?.[2] || fallbackScope || '相关功能').trim();
  const scope = scopeNames[rawScope.toLowerCase()] || rawScope;
  const action = (match?.[3] || summary).trim().replace(/[。；;]+$/, '');
  return { scope, action };
}
function groupProjectCommits(activity) {
  const groups = new Map();
  activity.commits.forEach(commit => {
    const { scope, action } = parseCommit(commit.summary, activity.name);
    const actions = groups.get(scope) || [];
    if (!actions.includes(action)) actions.push(action);
    groups.set(scope, actions);
  });
  return [...groups.entries()].map(([scope, actions]) => ({ scope, actions }));
}
function makeReportHtml(activities, isWeekly) {
  const totalCommits = activities.reduce((total, activity) => total + activity.commits.length, 0);
  const totalFiles = activities.reduce((total, activity) => total + activity.changedFiles, 0);
  const modules = [...new Set(activities.flatMap(activity => groupProjectCommits(activity).map(group => group.scope)))];
  const period = isWeekly ? '本周' : '今日';
  const overview = `<section><h3>工作概览</h3><ul><li>${period}完成 ${totalCommits} 项功能迭代，覆盖${modules.length ? ` ${modules.join('、')} 等` : ''}业务模块，涉及 ${totalFiles} 个文件变更。</li></ul></section>`;
  const details = activities.map(activity => {
    const groups = groupProjectCommits(activity);
    const lines = groups.length
      ? groups.map(group => `<li><strong>${escapeHtml(group.scope)}</strong>：${group.actions.map(escapeHtml).join('；')}。</li>`).join('')
      : '<li>该时间范围内没有新的 Git 提交。</li>';
    return `<section><h3>${escapeHtml(activity.name)} · ${isWeekly ? '本周完成' : '今日完成'}</h3><ul>${lines}</ul></section>`;
  }).join('');
  const followUp = isWeekly
    ? '<section><h3>下周计划</h3><ul><li>推进已完成需求的联调、测试与验收，跟进业务反馈并处理遗留问题。</li></ul></section>'
    : '<section><h3>待跟进</h3><ul><li>结合测试与业务验收反馈，确认上述功能的边界场景和后续优化项。</li></ul></section>';
  return overview + details + followUp;
}
async function generate() {
  if (!projects.length) { toast('请先添加至少一个项目'); return; }
  const button = $('#generate-report');
  button.disabled = true; button.querySelector('span').textContent = '正在读取 Git…';
  const d = new Date(`${date.value}T12:00:00`);
  let startDate = date.value, endDate = date.value;
  if (mode === 'weekly') { const day = d.getDay() || 7; const monday = new Date(d); monday.setDate(d.getDate() - day + 1); const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6); startDate = monday.toISOString().slice(0, 10); endDate = sunday.toISOString().slice(0, 10); }
  let activities;
  try {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 25_000);
    const response = await fetch('/api/git-activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paths: projects.map(p => p.path), startDate, endDate, onlyMine: $('#only-mine').checked }), signal: abort.signal });
    clearTimeout(timer);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    activities = result.activities;
  } catch (error) {
    button.disabled = false; button.querySelector('span').textContent = '生成报告';
    toast(error.name === 'AbortError' ? '读取 Git 超时，请确认项目目录可访问后重试' : `无法读取 Git：${error.message || String(error)}`); return;
  }
  try {
    const commits = activities.reduce((total, activity) => total + activity.commits.length, 0);
    const files = activities.reduce((total, activity) => total + activity.changedFiles, 0);
    const html = makeReportHtml(activities, mode === 'weekly');
    const body = $('#report-body');
    body.className = 'report-body'; body.contentEditable = 'true'; body.innerHTML = html;
    $('#report-kicker').textContent = mode === 'daily' ? 'DAILY DIGEST / GIT ACTIVITY' : 'WEEKLY DIGEST / GIT ACTIVITY';
    const dateText = mode === 'daily' ? `${d.getMonth() + 1} 月 ${d.getDate()} 日` : '本周';
    $('#report-title').textContent = `${dateText}工作${mode === 'daily' ? '日报' : '周报'}`;
    $('#report-meta').innerHTML = `<span>${date.value}</span><span>${activities.length} 个项目</span><span>${commits} 条提交</span><span>${files} 个文件变更</span><span>${$('#only-mine').checked ? '仅我的提交' : '所有作者'}</span>`;
    $('#copy-report').disabled = false; $('#export-report').disabled = false;
    $('#word-count').textContent = `${body.innerText.replace(/\s/g, '').length} 字 · 可直接编辑`;
    body.oninput = () => $('#word-count').textContent = `${body.innerText.replace(/\s/g, '').length} 字 · 已编辑`;
    activities.forEach((activity, index) => Object.assign(projects[index], { ...activity, gitCommits: activity.commits, commits: activity.commits.length, files: activity.changedFiles }));
    renderProjects();
    toast('报告已生成，可直接在右侧修改');
  } catch (error) {
    console.error('生成报告失败：', error);
    fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: `生成报告失败：${error.message || String(error)}` }) }).catch(() => {});
    toast(`报告渲染失败：${error.message || String(error)}`);
  } finally {
    button.disabled = false; button.querySelector('span').textContent = '生成报告';
  }
}
function reportText() { return `${$('#report-title').textContent}\n${$('#report-meta').innerText}\n\n${$('#report-body').innerText.trim()}`; }
function toast(text) { const el = $('#toast'); el.textContent = text; el.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => el.classList.remove('show'), 2400); }
$('#add-project').onclick = addProject;
$('#load-demo').onclick = () => {
  const input = window.prompt('输入项目目录的完整路径；多个目录请用换行分隔');
  if (!input) return;
  const added = addPaths(input.split(/\r?\n/));
  toast(added ? `已添加 ${added} 个项目` : '这些项目已经在列表中');
};
document.querySelectorAll('.segment').forEach(b => b.onclick = () => { mode = b.dataset.mode; document.querySelectorAll('.segment').forEach(x => x.classList.toggle('active', x === b)); updateDateHint(); });
date.onchange = updateDateHint; updateDateHint();
$('#generate-report').onclick = generate;
document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') generate(); });
$('#copy-report').onclick = async () => { await navigator.clipboard.writeText(reportText()); toast('报告已复制到剪贴板'); };
$('#export-report').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([reportText()], {type:'text/markdown'})); a.download = `${$('#report-title').textContent}.md`; a.click(); URL.revokeObjectURL(a.href); toast('Markdown 文件已导出'); };
$('#theme-toggle').onclick = () => document.body.classList.toggle('dark');
window.addEventListener('error', event => {
  fetch('/api/client-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: event.message }) }).catch(() => {});
});
