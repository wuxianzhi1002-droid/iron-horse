const root = document.querySelector("#root");
const dialog = document.querySelector("#dialog");
const toastNode = document.querySelector("#toast");
const DAY_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const state = { user: null, needsSetup: false, page: "", bootstrap: null, weekId: null, requestFilter: "pending" };

const esc = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
const localDay = (iso, offset = 0) => {
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}.${String(date.getUTCDate()).padStart(2, "0")}`;
};
const fmtDate = value => {
  if (!value) return "—";
  const date = new Date(value.includes("T") ? value : `${value}T12:00:00+08:00`);
  return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", timeZone: "Asia/Shanghai" }).format(date);
};

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}

function toast(message) {
  toastNode.textContent = message;
  toastNode.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toastNode.classList.remove("show"), 2600);
}

function setBusy(form, busy) {
  const button = form.querySelector("button[type=submit]");
  if (!button) return;
  button.disabled = busy;
  button.dataset.label ||= button.textContent;
  button.textContent = busy ? "处理中…" : button.dataset.label;
}

async function loadSession() {
  const session = await api("/api/session");
  state.user = session.user;
  state.needsSetup = session.needsSetup;
  if (state.user) {
    if (!state.page) state.page = state.user.role === "admin" ? "dashboard" : "schedule";
    await refreshData();
  } else renderLogin();
}

async function refreshData() {
  const suffix = state.weekId ? `?week=${encodeURIComponent(state.weekId)}` : "";
  state.bootstrap = await api(`/api/bootstrap${suffix}`);
  state.weekId = state.bootstrap.week.id;
  renderApp();
}

function renderLogin() {
  const setup = state.needsSetup;
  root.innerHTML = `<main class="login-page"><section class="login-story"><div class="brand"><span class="brand-mark"><i></i><i></i><i></i></span><span class="brand-copy"><strong>铁马驿站</strong><small>IRON HORSE · ROSTER</small></span></div><div class="story-copy"><div class="eyebrow">和值班伙伴，一起把日常安排好</div><h1>每一班，<br>都有人照应。</h1><p>报名、排班、请假补班，在一个清楚、可靠的地方完成。</p></div><div class="story-foot">铁马驿站 · 排班与协作平台</div></section><section class="login-side"><form class="login-card" data-form="${setup ? "setup" : "login"}"><div class="eyebrow">${setup ? "FIRST TIME SETUP" : "WELCOME BACK"}</div><h2>${setup ? "先创建管理员账号" : "登录排班中心"}</h2><p>${setup ? "管理员可以添加成员、收集报名、编排和发布排班。请设置一个安全的密码。" : "使用管理员分配给你的账号登录。"}</p>${setup ? `<div class="field"><label for="setupName">管理员姓名</label><input id="setupName" name="name" autocomplete="name" placeholder="例如：周老师" required /></div>` : ""}<div class="field"><label for="username">登录账号</label><input id="username" name="username" autocomplete="username" placeholder="输入账号" required /></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" autocomplete="${setup ? "new-password" : "current-password"}" minlength="${setup ? 10 : 1}" placeholder="${setup ? "至少 10 位" : "输入密码"}" required /></div>${setup ? `<p class="footnote">首次管理员由你在本机初始化；服务端仅保存密码哈希。</p>` : ""}<button class="primary-button full-width" type="submit">${setup ? "创建管理员并进入" : "登录"} <span>→</span></button></form></section></main>`;
}

const navFor = role => role === "admin" ? [
  ["dashboard", "总览", "◫"], ["schedule", "排班编制", "▦"], ["enrollments", "报名管理", "◷"], ["requests", "请假补班审批", "⇄"], ["members", "成员管理", "♙"], ["audit", "操作记录", "≋"],
] : [
  ["schedule", "整体排班", "▦"], ["enrollment", "我的空闲报名", "◷"], ["my-requests", "我的请假补班", "⇄"],
];

function pageTitle() {
  return navFor(state.user.role).find(item => item[0] === state.page)?.[1] || "排班中心";
}

function renderApp() {
  if (!state.user || !state.bootstrap) return renderLogin();
  const { user, week, weeks } = state.bootstrap;
  const nav = navFor(user.role);
  const pendingCount = user.role === "admin" ? state.bootstrap.requests.filter(request => request.status === "pending").length : 0;
  const mobileItems = user.role === "admin" ? [...nav.slice(0, 4), ["admin-more", "更多", "···"]] : nav;
  root.innerHTML = `<div class="app"><aside class="sidebar"><div class="brand"><span class="brand-mark"><i></i><i></i><i></i></span><span class="brand-copy"><strong>铁马驿站</strong><small>IRON HORSE · ROSTER</small></span></div><div class="nav-caption">${user.role === "admin" ? "工作台" : "我的值班"}</div><nav class="nav-list">${nav.slice(0, user.role === "admin" ? 4 : 3).map(([key, title, icon]) => navButton(key, title, icon, pendingCount)).join("")}</nav>${user.role === "admin" ? `<div class="nav-caption">管理</div><nav class="nav-list">${nav.slice(4).map(([key, title, icon]) => navButton(key, title, icon, pendingCount)).join("")}</nav>` : ""}<div class="sidebar-spacer"></div><div class="sidebar-week"><span>当前周次</span><strong>${esc(fmtDate(week.weekStart))} 周 · ${week.status === "published" ? "已发布" : "编排中"}</strong></div><div class="user-panel"><span class="user-avatar">${esc(user.name.slice(0, 1))}</span><span class="user-meta"><strong>${esc(user.name)}</strong><small>${user.role === "admin" ? "管理员" : "普通同学"}</small></span><button class="logout-button" data-action="logout" title="退出登录">↪</button></div></aside><main class="main"><header class="topbar"><div class="topbar-title"><strong>铁马驿站</strong>　/　${esc(pageTitle())}</div><div class="topbar-right"><select class="week-select" id="weekSelect" aria-label="选择周次">${weeks.map(item => `<option value="${item.id}" ${item.id === week.id ? "selected" : ""}>${esc(fmtDate(item.weekStart))} 周 · ${item.status === "published" ? "已发布" : "编排中"}</option>`).join("")}</select><span class="sync-label"><i></i>自动同步</span></div></header><div class="content" id="pageContent">${renderPage()}</div><nav class="mobile-nav ${user.role === "admin" ? "admin-mobile-nav" : "student-mobile-nav"}">${mobileItems.map(([key,title,icon]) => mobileButton(key,title,icon,pendingCount)).join("")}</nav></main></div>`;
  root.querySelector(".topbar-right").insertAdjacentHTML("afterbegin", `<button class="header-logout" data-action="logout" title="退出登录" aria-label="退出登录">↪</button>`);
}

function navButton(key, title, icon, pending) {
  return `<button class="nav-item ${state.page === key ? "active" : ""}" data-page="${key}"><span class="nav-symbol">${icon}</span>${title}${key === "requests" && pending ? `<span class="nav-count">${pending}</span>` : ""}</button>`;
}
function mobileButton(key, title, icon, pending) {
  const actionAttr = key === "admin-more" ? `data-action="admin-more"` : `data-page="${key}"`;
  return `<button class="${state.page === key ? "active" : ""}" ${actionAttr}><span>${icon}${key === "requests" && pending ? ` · ${pending}` : ""}</span><span>${title}</span></button>`;
}

function pageHead(title, description, actions = "") {
  return `<div class="page-head"><div><div class="eyebrow">${esc(pageTitle())} · ${esc(fmtDate(state.bootstrap.week.weekStart))}</div><h1>${title}</h1><p>${description}</p></div>${actions ? `<div class="head-actions">${actions}</div>` : ""}</div>`;
}

function renderPage() {
  if (state.user.role === "admin") {
    switch (state.page) {
      case "dashboard": return renderAdminDashboard();
      case "schedule": return renderScheduleEditor();
      case "enrollments": return renderEnrollments();
      case "requests": return renderAdminRequests();
      case "members": return renderMembers();
      case "audit": return renderAudit();
      default: return renderAdminDashboard();
    }
  }
  switch (state.page) {
    case "enrollment": return renderStudentEnrollment();
    case "my-requests": return renderMyRequests();
    default: return renderPublishedSchedule();
  }
}

function rosterSummary() {
  const shifts = state.bootstrap.schedule;
  const covered = shifts.filter(shift => shift.members.length).length;
  const techCovered = shifts.filter(shift => shift.members.some(member => member.isTech)).length;
  return { covered, techCovered, total: shifts.length, people: new Set(shifts.flatMap(shift => shift.members.map(member => member.id))).size };
}

function scheduleRows(shifts, compact = false) {
  const byDay = DAY_NAMES.map((day, dayIndex) => ({ day, dayIndex, shifts: shifts.filter(shift => shift.dayIndex === dayIndex) }));
  if (compact) {
    const today = byDay.find(day => day.shifts.length);
    return `<div class="schedule-preview">${(today?.shifts || []).map(shift => previewShift(shift)).join("") || `<div class="empty-state">${state.user.role === "admin" ? "当前还没有排班。" : "管理员发布排班后会显示在这里。"}</div>`}</div>`;
  }
  return `<div class="schedule-days">${byDay.map(day => `<article class="schedule-day"><div class="schedule-day-head">${day.day}<small>${localDay(state.bootstrap.week.weekStart, day.dayIndex)}</small></div>${day.shifts.map(shift => `<div class="day-shift"><div class="day-shift-label">${shift.period}班 <small>${esc(shift.startsAt)}–${esc(shift.endsAt)}</small></div>${shift.members.length ? shift.members.map(member => `<span class="day-member ${member.isTech ? "tech" : ""}">${member.isTech ? "✳ " : ""}${esc(member.name)}</span>`).join("") : `<span class="day-empty">${state.user.role === "admin" ? "尚未安排" : "暂空"}</span>`}</div>`).join("")}</article>`).join("")}</div>`;
}

function previewShift(shift) {
  return `<div class="preview-shift"><span class="preview-date">${shift.day}<small>${shift.period}班 · ${esc(shift.startsAt)}</small></span><span class="member-pills">${shift.members.length ? shift.members.map(member => `<span class="member-pill ${member.isTech ? "tech" : ""}">${member.isTech ? "✳ " : ""}${esc(member.name)}</span>`).join("") : `<span class="member-pill empty">待安排</span>`}</span><span class="member-total">${shift.members.length} 人</span></div>`;
}

function renderAdminDashboard() {
  const counts = rosterSummary();
  const enrollments = state.bootstrap.enrollments;
  const requests = state.bootstrap.requests.filter(request => request.status === "pending");
  return `${pageHead(`本周排班，一眼看清。`, `管理报名、处理申请，及时发布更新后的整体排班。`, `<button class="secondary-button" data-action="export-schedule">导出排班</button><button class="primary-button" data-page="schedule">进入排班编制 →</button>`)}<div class="stats"><article class="card stat"><div class="stat-label">成员报名</div><div class="stat-value">${enrollments.length}<small> 人</small></div><div class="stat-note">本周共 ${state.bootstrap.members.length} 位成员</div></article><article class="card stat"><div class="stat-label">排班覆盖</div><div class="stat-value">${counts.covered}<small> / ${counts.total}</small></div><div class="stat-note">${counts.people} 人参与本周值班</div></article><article class="card stat"><div class="stat-label">技师覆盖</div><div class="stat-value">${counts.techCovered}<small> / ${counts.total}</small></div><div class="stat-note">优先在每班安排正式技师</div></article><article class="card stat"><div class="stat-label">待审批</div><div class="stat-value">${requests.length}<small> 项</small></div><div class="stat-note">仅管理员可查看申请详情</div></article></div>${counts.techCovered < counts.total ? `<div class="notice"><span class="notice-icon">!</span><div><strong>有班次尚未安排技师</strong><p>${counts.total - counts.techCovered} 个班次需要管理员检查技师报名情况。</p></div></div>` : ""}<div class="dashboard-grid"><section class="card section-card"><div class="section-head"><div><div class="kicker">ROSTER PREVIEW</div><h2>排班预览</h2></div><button class="secondary-button" data-page="schedule">完整排班</button></div>${scheduleRows(state.bootstrap.schedule, true)}</section><section class="card section-card"><div class="section-head"><div><div class="kicker">APPROVAL QUEUE</div><h2>待审批申请</h2></div><button class="secondary-button" data-page="requests">全部申请 · ${requests.length}</button></div><div class="request-list">${requests.length ? requests.slice(0, 4).map(requestCard).join("") : `<div class="empty-state">目前没有待处理申请。</div>`}</div></section></div>`;
}

function renderScheduleEditor() {
  const actions = `<button class="secondary-button" data-action="new-week">＋ 新建周次</button><button class="secondary-button" data-action="auto-arrange">✳ 自动排班</button><button class="primary-button" data-action="publish">${state.bootstrap.week.status === "published" ? "再次发布更新" : "发布排班"} →</button>`;
  const versions = state.bootstrap.versions || [];
  return `${pageHead("把合适的人，安排到合适的班次。", "技师优先；同一同学尽量避免同日连班。每班最多 5 人。", actions)}${state.bootstrap.week.status === "published" ? `<div class="notice"><span class="notice-icon">✓</span><div><strong>本周排班已发布</strong><p>手动修改保存为草稿，点击「再次发布更新」后同学可见；请假和补班审批通过会立即生成新版本。</p></div></div>` : ""}<div class="toolbar"><div class="form-row"><span class="kicker">本周覆盖</span><span class="coverage">${rosterSummary().covered} / ${rosterSummary().total} 班次有人</span></div><button class="secondary-button" data-action="export-schedule">导出 CSV</button></div><div class="shift-grid">${state.bootstrap.schedule.map(shift => shiftEditorCard(shift)).join("")}</div><p class="footnote">正式技师显示在前。点击班次卡片中的「调整人员」选择名单；手动变更仅管理员可见，直到发布更新。</p><section class="card section-card version-panel"><div class="section-head"><div><div class="kicker">PUBLISHED VERSIONS</div><h2>最近发布记录</h2></div></div>${versions.length ? versions.slice(0,5).map(version=>`<div class="audit-row"><span class="audit-mark"></span><div><strong>版本 #${version.id} · ${esc(version.publisher)}</strong><small>${esc(version.createdAt)}</small></div></div>`).join("") : `<div class="empty-state">尚未发布过本周排班。</div>`}</section>`;
}

function shiftEditorCard(shift) {
  const members = state.bootstrap.members.filter(member => member.active);
  const selected = new Set(shift.members.map(member => member.id));
  return `<article class="card shift-card"><div class="shift-card-head"><div><strong>${shift.day} · ${shift.period}班</strong><small>${esc(shift.startsAt)}–${esc(shift.endsAt)}</small></div><span class="coverage ${shift.members.some(member => member.isTech) ? "" : "warn"}">${shift.members.length} / 5 人${shift.members.some(member => member.isTech) ? " · 技师已排" : " · 无技师"}</span></div><div class="member-pills">${shift.members.map(member => `<span class="member-pill ${member.isTech ? "tech" : ""}">${member.isTech ? "✳ " : ""}${esc(member.name)}</span>`).join("") || `<span class="member-pill empty">尚未安排</span>`}</div><details class="assign-details"><summary>调整人员</summary><div class="member-checks" data-shift-form="${shift.id}">${members.map(member => `<label><input type="checkbox" value="${member.id}" ${selected.has(member.id) ? "checked" : ""}><span>${esc(member.name)}${member.isTech ? " · 技师" : ""}</span></label>`).join("") || `<small>请先添加成员</small>`}</div><div class="shift-card-foot"><span>选择不超过 5 人</span><button class="secondary-button" data-action="save-shift" data-shift="${shift.id}">保存班次</button></div></details></article>`;
}

function renderEnrollments() {
  const enrollments = state.bootstrap.enrollments;
  return `${pageHead("每个人的可用时间都在这里。", "这些报名信息仅管理员可见，用于生成和调整排班。", `<button class="secondary-button" data-action="refresh">刷新报名</button>`)}<div class="stats"><article class="card stat"><div class="stat-label">已提交</div><div class="stat-value">${enrollments.length}<small> / ${state.bootstrap.members.length} 人</small></div><div class="stat-note">尚未报名 ${Math.max(0, state.bootstrap.members.length - enrollments.length)} 人</div></article><article class="card stat"><div class="stat-label">正式技师报名</div><div class="stat-value">${enrollments.filter(item => item.isTech).length}<small> 人</small></div><div class="stat-note">可在自动排班中优先安排</div></article><article class="card stat"><div class="stat-label">报名截止</div><div class="stat-value" style="font-size:18px">${esc(fmtDate(state.bootstrap.week.enrollmentDeadline))}</div><div class="stat-note">截止时间按周次设置</div></article><article class="card stat"><div class="stat-label">本周总时段</div><div class="stat-value">${state.bootstrap.schedule.length}<small> 班</small></div><div class="stat-note">每天上午、下午各一班</div></article></div><div class="enrollment-list">${enrollments.length ? enrollments.map(enrollmentCard).join("") : `<div class="card empty-state"><strong>还没有人报名</strong>创建成员账号后，同学可以登录填写下周空闲时间。</div>`}</div>`;
}

function enrollmentCard(item) {
  return `<article class="card enrollment-card"><span class="user-avatar">${esc(item.name.slice(0, 1))}</span><div class="enrollment-card-main"><div class="enrollment-name"><strong>${esc(item.name)}</strong>${item.isTech ? `<span class="tech-badge">正式技师</span>` : ""}</div><div class="enrollment-sub">期望 ${item.expectedCount} 次 · 更新于 ${esc(item.updatedAt)}</div><div class="slot-tags">${item.slots.map(slot => `<span class="slot-tag">${esc(slot)}</span>`).join("")}</div>${item.note ? `<div class="enrollment-sub">备注：${esc(item.note)}</div>` : ""}</div><span class="enrollment-count">${item.slots.length} 时段</span></article>`;
}

function requestCard(request) {
  const detail = `${request.day || ""} ${request.period || ""}班 · ${request.startsAt || ""}`;
  return `<article class="card request-card"><span class="user-avatar">${esc(request.name?.slice(0, 1) || "我")}</span><div class="request-main"><strong>${esc(request.name || "成员")} · ${esc(request.type)}</strong><small>${esc(detail)}<br>${esc(request.reason)}</small></div><span class="request-tag ${request.type === "补班" ? "makeup" : ""}">${esc(request.type)}</span>${request.status === "pending" ? `<div class="request-actions"><button class="danger-button" data-action="decide" data-id="${request.id}" data-status="rejected">拒绝</button><button class="primary-button" data-action="decide" data-id="${request.id}" data-status="approved">通过</button></div>` : `<span class="status ${request.status}">${statusText(request.status)}</span>`}</article>`;
}

function statusText(status) { return ({ pending: "待审批", approved: "已通过", rejected: "未通过" })[status] || status; }

function renderAdminRequests() {
  const pending = state.bootstrap.requests.filter(request => request.status === "pending");
  const done = state.bootstrap.requests.filter(request => request.status !== "pending");
  const visible = state.bootstrap.requests.filter(request => state.requestFilter === "all" || (state.requestFilter === "processed" ? request.status !== "pending" : request.status === "pending"));
  return `${pageHead("请假和补班，由管理员确认。", "通过后，系统会同步更新整体排班，并保留审批记录。", `<button class="secondary-button" data-action="refresh">刷新申请</button>`)}<div class="page-tabs"><button class="page-tab ${state.requestFilter === "pending" ? "active" : ""}" data-filter="pending">待审批 ${pending.length}</button><button class="page-tab ${state.requestFilter === "processed" ? "active" : ""}" data-filter="processed">已处理 ${done.length}</button><button class="page-tab ${state.requestFilter === "all" ? "active" : ""}" data-filter="all">全部 ${state.bootstrap.requests.length}</button></div><div class="request-list" id="requestsView">${visible.length ? visible.map(requestCard).join("") : `<div class="card empty-state"><strong>${state.requestFilter === "pending" ? "待审批已清空" : "目前没有申请记录"}</strong>新的请假或补班申请会显示在这里。</div>`}</div>`;
}

function renderMembers() {
  const members = state.bootstrap.members;
  return `${pageHead("管理成员与技师资格。", "账号由管理员创建并发给同学；普通成员之间不会互相看到申请或报名信息。") }<section class="card section-card"><div class="section-head"><div><div class="kicker">ADD MEMBER</div><h2>添加成员账号</h2><p>初始密码至少 10 位，之后交由成员使用。</p></div></div><form class="member-form" data-form="member"><div class="field"><label>姓名</label><input name="name" required maxlength="60" placeholder="成员姓名"></div><div class="field"><label>登录账号</label><input name="username" required maxlength="40" autocomplete="off" placeholder="学号或自定义账号"></div><div class="field"><label>初始密码</label><input name="password" type="password" required minlength="10" autocomplete="new-password" placeholder="至少 10 位"></div><label class="checkbox-field"><input type="checkbox" name="isTech"> 正式技师</label><button class="primary-button" type="submit">创建成员</button></form></section><section class="section-card" style="padding-left:0;padding-right:0"><div class="section-head" style="padding:0 2px"><div><div class="kicker">MEMBERS</div><h2>成员名单 · ${members.length}</h2></div></div><div class="member-list">${members.map(member => `<article class="card member-card"><span class="user-avatar">${esc(member.name.slice(0, 1))}</span><div class="member-info"><strong>${esc(member.name)} ${member.isTech ? `<span class="tech-badge">正式技师</span>` : ""}</strong><small>账号 ${esc(member.username)} · ${member.active ? "正常" : "已停用"}</small></div></article>`).join("") || `<div class="card empty-state">暂时没有成员，请先添加账号。</div>`}</div></section>`;
}

function renderAudit() {
  const audit = state.bootstrap.audit;
  const labels = { submit_enrollment: "提交了空闲报名", submit_request: "提交了班次申请", create_member: "添加了成员", auto_arrange: "生成了自动排班", edit_shift: "调整了班次人员", approve_request: "批准了申请", reject_request: "拒绝了申请", publish_week: "发布了排班", create_week: "新建了周次" };
  return `${pageHead("关键调整都留有记录。", "管理员操作日志仅管理员可见，方便回溯排班和审批变更。")}<section class="card section-card"><div class="audit-list">${audit.length ? audit.map(item => `<div class="audit-row"><span class="audit-mark"></span><div><strong>${esc(item.actorName)} ${esc(labels[item.action] || item.action)}</strong><small>${esc(item.createdAt)} · ${esc(item.objectType)} ${esc(item.details ? Object.values(item.details).join(" · ") : "")}</small></div></div>`).join("") : `<div class="empty-state">目前还没有操作记录。</div>`}</div></section>`;
}

function renderPublishedSchedule() {
  const isPublished = state.bootstrap.week.status === "published";
  return `${pageHead("本周整体排班", "所有同学看到相同的已发布排班；请假或补班获批后会同步更新。", `<button class="secondary-button" data-action="export-schedule">导出排班</button>`)}${!isPublished ? `<div class="notice"><span class="notice-icon">i</span><div><strong>本周排班尚未发布</strong><p>管理员发布后，你就能在这里看到整体排班。</p></div></div><section class="card empty-state"><strong>排班编制中</strong>你仍可提交空闲时间，也可以查看自己已提交的申请状态。</section>` : `<section class="card section-card"><div class="section-head"><div><div class="kicker">PUBLISHED ROSTER</div><h2>${esc(fmtDate(state.bootstrap.week.weekStart))} 起的一周</h2></div><span class="status approved">已发布</span></div>${scheduleRows(state.bootstrap.schedule)}</section>`}<p class="footnote">本页面只显示整体已发布排班及你的个人信息，不展示其他同学的报名、申请和操作动态。</p>`;
}

function renderStudentEnrollment() {
  const own = state.bootstrap.ownEnrollment;
  const checked = new Set(own?.slots || []);
  const deadlinePassed = Date.now() > new Date(state.bootstrap.week.enrollmentDeadline).getTime();
  return `${pageHead("告诉我们你什么时候方便。", `下周空闲时间仅本人和管理员可见。${deadlinePassed ? "本周报名已截止，请联系管理员。" : `报名截止：${fmtDate(state.bootstrap.week.enrollmentDeadline)}。`}`)}${own ? `<div class="notice"><span class="notice-icon">✓</span><div><strong>你已提交空闲报名</strong><p>截止前可修改。管理员排班时会参考你的期望次数。</p></div></div>` : ""}<section class="card section-card"><form data-form="enrollment"><div class="section-head"><div><h2>选择可值班时段</h2><p>你提交的信息不会展示给其他同学。</p></div></div><div class="page-tabs">${DAY_NAMES.map((day,index) => `<span class="page-tab">${day} · ${localDay(state.bootstrap.week.weekStart,index)}</span>`).join("")}</div><div class="availability-list">${DAY_NAMES.map((day,index) => `<div class="availability-row"><strong>${day}<small>${localDay(state.bootstrap.week.weekStart,index)}</small></strong>${["上午","下午"].map(period => {const key=`${day}-${period}`; return `<label><input type="checkbox" name="slots" value="${key}" ${checked.has(key)?"checked":""} ${deadlinePassed?"disabled":""}><span>${period}班 <small>${period === "上午" ? "08:00–12:00" : "13:30–17:30"}</small></span></label>`;}).join("")}</div>`).join("")}</div><div class="form-row enrollment-controls"><label class="field"><span>期望值班次数</span><select name="expectedCount" ${deadlinePassed?"disabled":""}>${Array.from({length:14},(_,i)=>i+1).map(count=>`<option value="${count}" ${(own?.expectedCount||2)===count?"selected":""}>${count} 次</option>`).join("")}</select></label><label class="field note-field"><span>补充说明（选填）</span><input name="note" maxlength="500" value="${esc(own?.note||"")}" placeholder="例如：周三下午有课"></label></div><button class="primary-button" type="submit" ${deadlinePassed?"disabled":""}>${own?"更新报名":"提交空闲时间"} →</button></form></section>`;
}

function renderMyRequests() {
  const requests = state.bootstrap.requests;
  const shifts = state.bootstrap.schedule;
  return `${pageHead("请假或需要补班？", "申请详情只有你和管理员可见；审批通过后，整体排班会同步更新。", `<button class="primary-button" data-action="new-request" ${shifts.length?"":"disabled"}>＋ 发起申请</button>`)}<div class="request-list">${requests.length ? requests.map(request => `<article class="card own-request"><div><strong>${esc(request.type)} · ${esc(request.day)} ${esc(request.period)}班</strong><small>${esc(request.reason)} · ${esc(fmtDate(request.submittedAt))}</small></div><span class="status ${request.status}">${statusText(request.status)}</span></article>`).join("") : `<div class="card empty-state"><strong>暂无申请</strong>需要请假或补班时，点击上方按钮发起申请。</div>`}</div>`;
}

function openRequestDialog() {
  const shifts = state.bootstrap.schedule;
  const mine = shift => shift.members.some(member => member.id === state.user.id);
  const candidates = type => shifts.filter(shift => type === "请假" ? mine(shift) : !mine(shift) && shift.members.length < 5);
  const options = type => candidates(type).map(shift=>`<option value="${shift.id}">${shift.day} ${shift.period}班 · ${shift.startsAt}</option>`).join("");
  dialog.innerHTML = `<form data-form="request"><h2>发起请假或补班申请</h2><p>请假获批后将从整体排班中移除你；补班获批后会加入对应班次。</p><label class="field"><span>申请类型</span><select name="type"><option>请假</option><option>补班</option></select></label><label class="field"><span>涉及班次</span><select name="shiftId" required>${options("请假")}</select></label><label class="field"><span>申请说明</span><textarea name="reason" required maxlength="500" placeholder="请简要说明原因"></textarea></label><div class="dialog-actions"><button type="button" class="secondary-button" data-action="close-dialog">取消</button><button type="submit" class="primary-button" ${candidates("请假").length ? "" : "disabled"}>提交申请</button></div></form>`;
  const form = dialog.querySelector("form");
  form.querySelector('[name="type"]').addEventListener("change", event => {
    const list = candidates(event.target.value);
    form.querySelector('[name="shiftId"]').innerHTML = options(event.target.value);
    form.querySelector('[type="submit"]').disabled = !list.length;
    form.querySelector('[type="submit"]').textContent = list.length ? "提交申请" : "没有可申请的班次";
  });
  if (!candidates("请假").length) form.querySelector('[type="submit"]').textContent = "没有可申请的班次";
  dialog.showModal();
}

function openWeekDialog() {
  const start = state.bootstrap.week.weekStart;
  const next = new Date(`${start}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 7);
  const nextStart = next.toISOString().slice(0, 10);
  dialog.innerHTML = `<form data-form="week"><h2>新建周次</h2><p>每周 7 天、每天上午和下午各生成一个班次。</p><label class="field"><span>周一日期</span><input name="weekStart" type="date" value="${nextStart}" required></label><label class="field"><span>空闲报名截止时间</span><input name="enrollmentDeadline" type="datetime-local" required></label><div class="dialog-actions"><button type="button" class="secondary-button" data-action="close-dialog">取消</button><button type="submit" class="primary-button">创建周次</button></div></form>`;
  const deadline = dialog.querySelector('[name="enrollmentDeadline"]');
  const date = new Date(`${nextStart}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 3);
  deadline.value = `${date.toISOString().slice(0,10)}T22:00`;
  dialog.showModal();
}

function exportSchedule() {
  const rows = [["日期", "班次", "时间", "成员", "正式技师"]];
  for (const shift of state.bootstrap.schedule) rows.push([`${state.bootstrap.week.weekStart} ${shift.day}`, `${shift.period}班`, `${shift.startsAt}-${shift.endsAt}`, shift.members.map(member=>member.name).join("、"), shift.members.filter(member=>member.isTech).map(member=>member.name).join("、")]);
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"','""')}"`).join(",")).join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(["\ufeff",csv],{type:"text/csv;charset=utf-8"}));
  link.download = `铁马驿站_${state.bootstrap.week.weekStart}_排班.csv`;
  link.click();
  setTimeout(()=>URL.revokeObjectURL(link.href),1000);
}

async function handleSubmit(form) {
  const data = new FormData(form);
  setBusy(form, true);
  try {
    const kind = form.dataset.form;
    if (kind === "setup") {
      await api("/api/setup", { method: "POST", body: JSON.stringify(Object.fromEntries(data)) });
      toast("管理员账号已创建");
      await loadSession();
      return;
    }
    if (kind === "login") {
      await api("/api/login", { method: "POST", body: JSON.stringify(Object.fromEntries(data)) });
      state.page = "";
      await loadSession();
      return;
    }
    if (kind === "enrollment") {
      const slots = data.getAll("slots");
      const expectedCount = Number(data.get("expectedCount"));
      if (!slots.length) throw new Error("请至少选择一个有空时段");
      if (expectedCount > slots.length) throw new Error("期望次数不能超过已选时段数");
      await api("/api/enrollment", { method: "PUT", body: JSON.stringify({ weekId: state.weekId, slots, expectedCount, note: data.get("note") }) });
      await refreshData();
      toast("空闲报名已保存，仅你和管理员可见");
    } else if (kind === "request") {
      await api("/api/requests", { method: "POST", body: JSON.stringify(Object.fromEntries(data)) });
      dialog.close();
      await refreshData();
      toast("申请已提交，审批状态只有你和管理员可见");
    } else if (kind === "member") {
      await api("/api/admin/members", { method: "POST", body: JSON.stringify({ name: data.get("name"), username: data.get("username"), password: data.get("password"), isTech: data.has("isTech") }) });
      await refreshData();
      toast("成员账号已创建");
    } else if (kind === "week") {
      const value = Object.fromEntries(data);
      value.enrollmentDeadline = new Date(`${value.enrollmentDeadline}:00+08:00`).toISOString();
      const result = await api("/api/admin/weeks", { method: "POST", body: JSON.stringify(value) });
      dialog.close();
      state.weekId = result.week.id;
      state.page = "schedule";
      await refreshData();
      toast("新周次已创建");
    }
  } catch (error) { toast(error.message); }
  finally { setBusy(form, false); }
}

async function action(button) {
  const name = button.dataset.action;
  try {
    if (name === "reload") location.reload();
    else if (name === "logout") {
      await api("/api/logout", { method: "POST" });
      state.user = null; state.bootstrap = null; state.page = "";
      await loadSession();
    } else if (name === "refresh") {
      await refreshData(); toast("数据已刷新");
    } else if (name === "export-schedule") exportSchedule();
    else if (name === "new-request") openRequestDialog();
    else if (name === "admin-more") {
      dialog.innerHTML = `<h2>管理功能</h2><p>选择管理页面</p><div class="more-links"><button class="secondary-button" data-page="members">成员管理</button><button class="secondary-button" data-page="audit">操作记录</button></div><div class="dialog-actions"><button class="secondary-button" data-action="close-dialog">关闭</button></div>`;
      dialog.showModal();
    }
    else if (name === "new-week") openWeekDialog();
    else if (name === "close-dialog") dialog.close();
    else if (name === "auto-arrange") {
      const result = await api("/api/admin/schedule/auto", { method: "POST", body: JSON.stringify({ weekId: state.weekId }) });
      await refreshData();
      toast(`已安排 ${result.assigned} 人次，${result.uncovered} 个班次为空`);
    } else if (name === "publish") {
      if (!confirm("发布或更新本周排班？普通同学随后可以看到整体排班。")) return;
      await api(`/api/admin/weeks/${state.weekId}/publish`, { method: "POST" });
      await refreshData(); toast("排班已发布并同步给同学");
    } else if (name === "save-shift") {
      const shiftId = button.dataset.shift;
      const form = document.querySelector(`[data-shift-form="${shiftId}"]`);
      const memberIds = [...form.querySelectorAll("input:checked")].map(input=>Number(input.value));
      if (memberIds.length > 5) throw new Error("每班最多安排 5 人");
      await api(`/api/admin/shifts/${shiftId}`, { method: "PUT", body: JSON.stringify({ memberIds }) });
      await refreshData(); toast("班次人员已更新");
    } else if (name === "decide") {
      const requestId = button.dataset.id;
      const status = button.dataset.status;
      await api(`/api/admin/requests/${requestId}`, { method: "PATCH", body: JSON.stringify({ status }) });
      await refreshData(); toast(status === "approved" ? "申请已通过，整体排班已同步" : "申请已拒绝");
    }
  } catch (error) { toast(error.message); }
}

root.addEventListener("submit", event => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  handleSubmit(form);
});

dialog.addEventListener("submit", event => {
  const form = event.target.closest("form[data-form]");
  if (!form) return;
  event.preventDefault();
  handleSubmit(form);
});

root.addEventListener("click", event => {
  const page = event.target.closest("[data-page]");
  if (page) {
    state.page = page.dataset.page;
    renderApp();
    return;
  }
  const button = event.target.closest("[data-action]");
  const filter = event.target.closest("[data-filter]");
  if (filter) {
    state.requestFilter = filter.dataset.filter;
    renderApp();
    return;
  }
  if (button) action(button);
});

root.addEventListener("change", async event => {
  if (event.target.id === "weekSelect") {
    state.weekId = Number(event.target.value);
    await refreshData();
  }
});

document.addEventListener("click", event => {
  if (event.target === dialog) dialog.close();
  const page = event.target.closest(".dialog [data-page]");
  if (page) { dialog.close(); state.page = page.dataset.page; renderApp(); }
  const button = event.target.closest(".dialog [data-action]");
  if (button?.dataset.action === "close-dialog") dialog.close();
});

loadSession().catch(error => {
  root.innerHTML = `<main class="login-page"><section class="login-side"><div class="login-card"><div class="eyebrow">SERVER CONNECTION</div><h2>暂时连不上排班服务</h2><p>${esc(error.message)}<br>请确认服务端已启动，然后刷新页面。</p><button class="primary-button" data-action="reload">重新连接</button></div></section></main>`;
});

setInterval(async () => {
  if (!state.user || document.hidden || dialog.open || root.contains(document.activeElement) && document.activeElement.matches("input,select,textarea")) return;
  try { await refreshData(); } catch { /* Keep the current screen during a brief network interruption. */ }
}, 30_000);

