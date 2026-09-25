const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const DATES = ["09.28", "09.29", "09.30", "10.01", "10.02", "10.03", "10.04"];
const DEMO = {
  weekShifts: [
    [["周老师", true], ["林知夏", false], ["陈一帆", false]],
    [["赵老师", true], ["许嘉禾", false]],
    [["周老师", true], ["唐可", false], ["林知夏", false]],
    [["陈老师", true], ["陈一帆", false]],
    [["赵老师", true], ["许嘉禾", false], ["唐可", false]],
    [["周老师", true], ["林知夏", false]],
    [["陈老师", true], ["陈一帆", false]],
  ],
  requests: [
    { id: 1, name: "林知夏", initial: "林", tone: "lilac", type: "请假", shift: "周三 下午班", detail: "9 月 30 日 · 13:30–17:30", reason: "临时有课程安排，希望能协调代班。", status: "pending", time: "10:32" },
    { id: 2, name: "陈一帆", initial: "陈", tone: "mint", type: "补班", shift: "周五 上午班", detail: "10 月 2 日 · 08:00–12:00", reason: "上周请假，申请补一个上午班。", status: "pending", time: "09:46" },
    { id: 3, name: "许嘉禾", initial: "许", tone: "blue", type: "换班", shift: "周六 上午班", detail: "10 月 3 日 · 与唐可互换", reason: "已和唐可沟通好，申请互换本周班次。", status: "pending", time: "昨天" },
    { id: 4, name: "唐可", initial: "唐", tone: "peach", type: "请假", shift: "周二 下午班", detail: "9 月 29 日 · 13:30–17:30", reason: "身体不适，无法到岗。", status: "approved", time: "昨天" },
  ],
  punches: [
    ["林知夏", "林", "08:57", "正常", "IH-TERM-001"],
    ["陈一帆", "陈", "09:02", "迟到 2 分钟", "IH-TERM-001"],
    ["许嘉禾", "许", "09:11", "正常", "IH-TERM-001"],
    ["唐可", "唐", "09:14", "正常", "IH-TERM-001"],
    ["周老师", "周", "13:26", "正常", "IH-TERM-001"],
    ["赵老师", "赵", "13:29", "正常", "IH-TERM-001"],
  ],
};

const saved = JSON.parse(localStorage.getItem("ironHorseDemo") || "{}");
const state = {
  role: saved.role || "admin",
  requests: saved.requests || DEMO.requests.map(item => ({ ...item })),
  enrollment: saved.enrollment || null,
  currentPage: "overview",
  filter: "pending",
  selectedDay: 0,
  count: 2,
};

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const save = () => localStorage.setItem("ironHorseDemo", JSON.stringify({ role: state.role, requests: state.requests, enrollment: state.enrollment }));
const esc = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function updateRole() {
  document.body.dataset.role = state.role;
  const admin = state.role === "admin";
  $("#roleSelect").value = state.role;
  $("#profileName").textContent = admin ? "周老师" : "林知夏";
  $("#profileRole").textContent = admin ? "排班管理员" : "普通同学";
  $("#profileAvatar").textContent = admin ? "周" : "林";
  $("#greetingName").textContent = admin ? "周老师" : "林知夏";
  $$(".admin-only").forEach(element => { element.hidden = !admin; });
  $$(".student-only").forEach(element => { element.hidden = admin; });
  if (!admin && ["members", "settings"].includes(state.currentPage)) navigate("overview");
  renderRequests();
}

function navigate(page) {
  if (state.role === "student" && ["members", "settings"].includes(page)) page = "overview";
  state.currentPage = page;
  $$(".page-view").forEach(section => { section.hidden = section.id !== `page-${page}`; });
  $$(".nav-item").forEach(button => button.classList.toggle("active", button.dataset.page === page));
  const active = $(`.nav-item[data-page="${page}"] span:nth-child(2)`);
  $("#breadcrumbCurrent").textContent = active?.textContent || ({ overview: "总览", schedule: "排班表", enrollment: "空闲报名", requests: "请假与补班", attendance: "考勤记录", members: "成员管理", settings: "规则设置" })[page];
  $("#sidebar").classList.remove("open");
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (page === "schedule") renderRoster();
  if (page === "requests") renderRequests();
}

function renderWeekStrip() {
  $("#weekStrip").innerHTML = DAYS.map((day, index) => `<button class="day-chip ${state.selectedDay === index ? "selected" : ""}" data-day="${index}"><span>${day}</span><b>${DATES[index]}</b><em></em></button>`).join("");
  $$(".day-chip").forEach(button => button.addEventListener("click", () => { state.selectedDay = Number(button.dataset.day); renderWeekStrip(); renderTodayShifts(); }));
}

function renderTodayShifts() {
  const index = state.selectedDay;
  const shiftLabels = ["上午班", "下午班"];
  const shifts = [DEMO.weekShifts[index], index === 0 ? [["赵老师", true], ["唐可", false]] : index === 1 ? [["赵老师", true], ["陈一帆", false]] : [["陈老师", true], ["许嘉禾", false]]];
  $("#todayShifts").innerHTML = shifts.map((people, slot) => `<div class="shift-row"><div class="shift-time">${slot === 0 ? "08:00" : "13:30"}<small>${shiftLabels[slot]}</small></div><div class="shift-people">${people.map(([name, tech]) => `<span class="person-chip ${tech ? "tech-chip" : ""}"><i class="tiny-avatar">${esc(name[0])}</i>${esc(name)}</span>`).join("")}</div><span class="shift-headcount">${people.length} 人</span></div>`).join("");
}

function renderApprovalPreview() {
  const pending = state.requests.filter(item => item.status === "pending").slice(0, 3);
  $("#approvalPreview").innerHTML = pending.length ? pending.map(item => `<div class="approval-item"><span class="request-avatar avatar-${item.tone}">${esc(item.initial)}</span><div class="request-main"><strong>${esc(item.name)} · ${esc(item.type)}</strong><p>${esc(item.shift)}　${esc(item.time)}</p></div><span class="request-type ${item.type === "补班" ? "type-makeup" : ""}">${esc(item.type)}</span><div class="quick-actions"><button data-approve="${item.id}" aria-label="通过">✓</button><button data-reject="${item.id}" aria-label="拒绝">×</button></div></div>`).join("") : `<div class="empty-inline">目前没有待处理申请 ✳</div>`;
  $$("[data-approve]").forEach(button => button.addEventListener("click", () => decideRequest(Number(button.dataset.approve), "approved")));
  $$("[data-reject]").forEach(button => button.addEventListener("click", () => decideRequest(Number(button.dataset.reject), "rejected")));
}

function renderRoster() {
  const labels = ["上午班", "下午班"];
  let rows = "";
  for (let slot = 0; slot < 2; slot++) {
    rows += `<tr><td class="shift-col"><span class="shift-label">${labels[slot]}<small>${slot === 0 ? "08:00–12:00" : "13:30–17:30"}</small></span></td>`;
    for (let day = 0; day < 7; day++) {
      let people = slot === 0 ? DEMO.weekShifts[day] : day === 0 ? [["赵老师", true], ["唐可", false]] : day === 1 ? [["赵老师", true], ["陈一帆", false]] : [["陈老师", true], ["许嘉禾", false]];
      const edits = state.requests.filter(item => item.status === "approved" && item.type === "请假" && item.shift.startsWith(DAYS[day]));
      if (edits.length && day === 1 && slot === 1) people = [["赵老师", true], ["周老师", false]];
      rows += `<td>${people.map(([name, tech]) => `<div class="roster-person ${tech ? "tech-person" : ""}"><i>${esc(name[0])}</i>${esc(name)}</div>`).join("") || `<span class="empty-slot">待安排</span>`}</td>`;
    }
    rows += `</tr>`;
  }
  $("#rosterBody").innerHTML = rows;
}

function requestCard(item) {
  const statusLabel = { pending: "待审批", approved: "已通过", rejected: "已拒绝" }[item.status];
  const actions = state.role === "admin" && item.status === "pending" ? `<div class="request-card-actions"><button class="reject-button" data-reject="${item.id}">拒绝</button><button class="approve-button" data-approve="${item.id}">通过申请</button></div>` : `<span class="request-status ${item.status === "rejected" ? "status-rejected" : ""}">${statusLabel}</span>`;
  return `<article class="panel request-card"><span class="request-avatar avatar-${item.tone}">${esc(item.initial)}</span><div class="request-card-main"><div class="request-card-title"><strong>${esc(item.name)}</strong><p>提交了${esc(item.type)}申请</p><span class="request-type ${item.type === "补班" ? "type-makeup" : ""}">${esc(item.type)}</span></div><div class="request-card-meta"><span>▦ ${esc(item.shift)}</span><span>◷ ${esc(item.detail)}</span><span>${esc(item.time)} 提交</span></div></div><p class="request-reason">${esc(item.reason)}</p>${actions}</article>`;
}

function renderRequests() {
  if (!$("#requestList")) return;
  const pendingCount = state.requests.filter(item => item.status === "pending").length;
  $("#requestCount").textContent = pendingCount;
  $("#pendingMetric").innerHTML = `${pendingCount}<span class="metric-unit">项</span>`;
  $("#approvalHeadingCount").textContent = pendingCount;
  $("#pendingTabCount").textContent = pendingCount;
  renderApprovalPreview();
  const query = $("#requestSearch").value.trim().toLowerCase();
  const visible = state.requests.filter(item => (state.filter === "all" || item.status === state.filter) && `${item.name} ${item.shift} ${item.type}`.toLowerCase().includes(query));
  $("#requestList").innerHTML = visible.length ? visible.map(requestCard).join("") : `<div class="panel empty-state">没有找到符合条件的申请。</div>`;
  $$("#requestList [data-approve]").forEach(button => button.addEventListener("click", () => decideRequest(Number(button.dataset.approve), "approved")));
  $$("#requestList [data-reject]").forEach(button => button.addEventListener("click", () => decideRequest(Number(button.dataset.reject), "rejected")));
}

function decideRequest(id, status) {
  if (state.role !== "admin") return showToast("请切换到管理员视角处理申请");
  const request = state.requests.find(item => item.id === id);
  if (!request) return;
  request.status = status;
  save();
  renderRequests();
  renderRoster();
  showToast(status === "approved" ? `${request.name} 的${request.type}申请已通过，排班已更新` : `${request.name} 的申请已拒绝`);
}

function renderAvailability() {
  const dateLabels = ["09.28", "09.29", "09.30", "10.01", "10.02", "10.03", "10.04"];
  const selected = state.enrollment?.slots || [];
  $("#availabilityGrid").innerHTML = DAYS.map((day, index) => `<div class="availability-day"><div class="availability-day-head">${day}<small>${dateLabels[index]}</small></div>${["上午", "下午"].map(slot => { const key = `${day}-${slot}`; return `<label class="slot-option"><input type="checkbox" value="${key}" ${selected.includes(key) ? "checked" : ""} /><span>${slot}</span></label>`; }).join("")}</div>`).join("");
  if (state.enrollment) {
    $("#expectedCount").textContent = state.enrollment.count;
    $("#countMinus").dataset.value = state.enrollment.count;
    $("#countPlus").dataset.value = state.enrollment.count;
    $("#enrollmentNote").value = state.enrollment.note || "";
    $("#savedLabel").textContent = `上次保存：${state.enrollment.savedAt}`;
  }
}

function renderAttendance() {
  $("#attendanceRows").innerHTML = DEMO.punches.map(([name, initial, time, status, device]) => `<tr><td><span class="table-member"><i class="activity-avatar avatar-${name === "林知夏" ? "lilac" : name === "陈一帆" ? "mint" : name === "许嘉禾" ? "blue" : "peach"}">${initial}</i>${name}</span></td><td>${time < "12:00" ? "周一 · 上午班" : "周一 · 下午班"}</td><td><span class="mono-time">${time}</span></td><td><span class="mono-time">${time < "12:00" ? "12:03" : "—"}</span></td><td>${device}</td><td><span class="attendance-status ${status.includes("迟到") ? "late" : ""}">${status}</span></td></tr>`).join("");
  $("#recentPunches").innerHTML = DEMO.punches.slice(0, 3).map(([name, initial, time, status]) => `<div class="punch-row"><span class="punch-avatar">${initial}</span><strong>${name}</strong><time>${time}</time><span class="punch-status ${status.includes("迟到") ? "late" : ""}">${status}</span></div>`).join("");
}

function submitEnrollment() {
  const slots = $$("#availabilityGrid input:checked").map(input => input.value);
  if (!slots.length) return showToast("请至少选择一个有空时段");
  const count = Number($("#expectedCount").textContent);
  if (count > slots.length) return showToast("期望次数不能大于已选时段数");
  const now = new Date();
  state.enrollment = { slots, count, note: $("#enrollmentNote").value.trim(), savedAt: `${now.getMonth() + 1} 月 ${now.getDate()} 日 ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}` };
  save();
  $("#savedLabel").textContent = `上次保存：${state.enrollment.savedAt}`;
  showToast("空闲时间已提交，截止前仍可修改");
}

function downloadCsv(filename, rows) {
  const csv = rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function init() {
  $("#roleSelect").addEventListener("change", event => { state.role = event.target.value; save(); updateRole(); showToast(state.role === "admin" ? "已切换到管理员体验视角" : "已切换到普通同学体验视角"); });
  $$(".nav-item").forEach(button => button.addEventListener("click", () => navigate(button.dataset.page)));
  $$('[data-go]').forEach(button => button.addEventListener("click", () => navigate(button.dataset.go)));
  $("#mobileMenu").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#helpButton").addEventListener("click", () => showToast("这是网页体验版，示例数据仅保存在当前浏览器"));
  $("#notificationButton").addEventListener("click", () => showToast("你有 3 项申请待处理"));
  $("#profileButton").addEventListener("click", () => { state.role = state.role === "admin" ? "student" : "admin"; save(); updateRole(); });
  $("#countMinus").addEventListener("click", () => { state.count = Math.max(1, state.count - 1); $("#expectedCount").textContent = state.count; });
  $("#countPlus").addEventListener("click", () => { state.count = Math.min(7, state.count + 1); $("#expectedCount").textContent = state.count; });
  $("#submitEnrollment").addEventListener("click", submitEnrollment);
  $$(".filter-tab").forEach(button => button.addEventListener("click", () => { state.filter = button.dataset.filter; $$(".filter-tab").forEach(tab => tab.classList.toggle("active", tab === button)); renderRequests(); }));
  $("#requestSearch").addEventListener("input", renderRequests);
  $("#newRequestButton").addEventListener("click", () => $("#requestModal").showModal());
  $("#requestForm").addEventListener("submit", event => {
    if (event.submitter?.value !== "submit") return;
    event.preventDefault();
    const type = $("#requestType").value;
    const shift = $("#requestShift").value;
    const reason = $("#requestReason").value.trim();
    if (!reason) return showToast("请填写申请说明");
    state.requests.unshift({ id: Date.now(), name: "林知夏", initial: "林", tone: "lilac", type, shift, detail: "待管理员确认", reason, status: "pending", time: "刚刚" });
    save();
    $("#requestModal").close();
    $("#requestReason").value = "";
    renderRequests();
    showToast("申请已提交，管理员审核后会通知你");
  });
  const exportRows = () => [["成员", "班次", "类型", "说明", "状态", "提交时间"], ...state.requests.map(item => [item.name, item.shift, item.type, item.reason, item.status, item.time])];
  ["#exportButton", "#scheduleExport", "#requestExport"].forEach(selector => $(selector)?.addEventListener("click", () => { downloadCsv("铁马驿站_第4周排班与申请.csv", exportRows()); showToast("报表已导出为 CSV 文件"); }));
  $("#attendanceExport").addEventListener("click", () => { downloadCsv("铁马驿站_打卡记录.csv", [["成员", "签到时间", "考勤状态", "设备"], ...DEMO.punches.map(([name, , time, status, device]) => [name, time, status, device])]); showToast("打卡记录已导出为 CSV 文件"); });
  $("#publishButton").addEventListener("click", () => showToast("第 4 周排班已发布，成员将收到通知"));
  $("#autoArrange").addEventListener("click", () => showToast("已生成排班建议，请检查技师覆盖后再发布"));
  $("#syncPunches").addEventListener("click", () => showToast("演示设备在线，已同步至 10:42 的打卡记录"));
  $("#deviceSettings").addEventListener("click", () => showToast("设备 API 配置将在后端接入后开放"));
  $("#inviteButton").addEventListener("click", () => showToast("成员邀请功能将在账号系统接入后开放"));
  $("#weekSelect").addEventListener("change", event => { $(".full-schedule-heading h2").textContent = event.target.value.split(" · ")[0] + "排班表"; showToast("已切换展示周次（示例排班数据）"); });
  renderWeekStrip();
  renderTodayShifts();
  renderRoster();
  renderAvailability();
  renderAttendance();
  renderRequests();
  updateRole();
}

init();

