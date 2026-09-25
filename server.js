import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = resolve(process.env.DB_PATH || join(ROOT, "data", "iron-horse.sqlite"));
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const sessions = new Map();
mkdirSync(join(DB_FILE, ".."), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','student')),
    is_tech INTEGER NOT NULL DEFAULT 0,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS weeks (
    id INTEGER PRIMARY KEY,
    week_start TEXT NOT NULL UNIQUE,
    enrollment_deadline TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS shifts (
    id INTEGER PRIMARY KEY,
    week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
    day_index INTEGER NOT NULL,
    period TEXT NOT NULL CHECK(period IN ('上午','下午')),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    UNIQUE(week_id, day_index, period)
  );
  CREATE TABLE IF NOT EXISTS enrollments (
    id INTEGER PRIMARY KEY,
    week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    slots_json TEXT NOT NULL,
    expected_count INTEGER NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(week_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS assignments (
    shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(shift_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS schedule_publications (
    id INTEGER PRIMARY KEY,
    week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
    published_by INTEGER NOT NULL REFERENCES users(id),
    snapshot_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS requests (
    id INTEGER PRIMARY KEY,
    week_id INTEGER NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    type TEXT NOT NULL CHECK(type IN ('请假','补班')),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TEXT,
    reviewed_by INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const DAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const MAX_PER_SHIFT = 5;

function shanghaiDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function defaultWeekStart() {
  const today = new Date(`${shanghaiDate()}T12:00:00+08:00`);
  const daysUntilMonday = (8 - today.getDay()) % 7 || 7;
  today.setDate(today.getDate() + daysUntilMonday);
  return shanghaiDate(today);
}

function createWeek(weekStart, deadline = null) {
  const [year, month, day] = weekStart.split("-").map(Number);
  const monday = new Date(Date.UTC(year, month - 1, day, 4));
  const deadlineDate = new Date(monday);
  deadlineDate.setUTCDate(deadlineDate.getUTCDate() - 3);
  const cutoff = deadline || `${deadlineDate.toISOString().slice(0, 10)}T22:00:00+08:00`;
  const result = db.prepare("INSERT INTO weeks (week_start, enrollment_deadline) VALUES (?, ?)").run(weekStart, cutoff);
  const weekId = Number(result.lastInsertRowid);
  const insertShift = db.prepare("INSERT INTO shifts (week_id, day_index, period, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)");
  const insertMany = db.transaction(() => {
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      for (const [period, starts, ends] of [["上午", "08:00", "12:00"], ["下午", "13:30", "17:30"]]) {
        insertShift.run(weekId, dayIndex, period, starts, ends);
      }
    }
  });
  insertMany();
  return db.prepare("SELECT * FROM weeks WHERE id = ?").get(weekId);
}

if (!db.prepare("SELECT id FROM weeks LIMIT 1").get()) createWeek(defaultWeekStart());

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}

function publicUser(user) {
  return { id: user.id, username: user.username, name: user.display_name, role: user.role, isTech: Boolean(user.is_tech) };
}

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function setSessionCookie(res, token) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `ih_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.COOKIE_SECURE === "1" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `ih_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

function currentUser(req) {
  const token = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith("ih_session="))?.slice("ih_session=".length);
  const session = token && sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND active = 1").get(session.userId);
  return user || null;
}

function readJson(req) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    req.on("data", chunk => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(Object.assign(new Error("请求内容过大"), { status: 413 }));
        req.destroy();
      }
    });
    req.on("end", () => {
      try { resolveBody(body ? JSON.parse(body) : {}); }
      catch { reject(Object.assign(new Error("请求格式错误"), { status: 400 })); }
    });
    req.on("error", reject);
  });
}

function requireUser(user) {
  if (!user) throw Object.assign(new Error("请先登录"), { status: 401 });
}

function requireAdmin(user) {
  requireUser(user);
  if (user.role !== "admin") throw Object.assign(new Error("没有管理员权限"), { status: 403 });
}

function requireText(value, field, max = 120) {
  const text = String(value || "").trim();
  if (!text || text.length > max) throw Object.assign(new Error(`${field}不能为空且不超过 ${max} 个字符`), { status: 400 });
  return text;
}

function weekPayload(weekId, user) {
  const week = db.prepare("SELECT * FROM weeks WHERE id = ?").get(weekId);
  if (!week) throw Object.assign(new Error("找不到该周次"), { status: 404 });
  const shifts = db.prepare(`
    SELECT s.id, s.day_index AS dayIndex, s.period, s.starts_at AS startsAt, s.ends_at AS endsAt,
      u.id AS userId, u.display_name AS name, u.is_tech AS isTech
    FROM shifts s LEFT JOIN assignments a ON a.shift_id=s.id
    LEFT JOIN users u ON u.id=a.user_id AND u.active=1
    WHERE s.week_id=? ORDER BY s.day_index, CASE s.period WHEN '上午' THEN 0 ELSE 1 END, a.position, u.display_name
  `).all(weekId);
  const grouped = new Map();
  for (const row of shifts) {
    if (!grouped.has(row.id)) grouped.set(row.id, { id: row.id, dayIndex: row.dayIndex, day: DAYS[row.dayIndex], period: row.period, startsAt: row.startsAt, endsAt: row.endsAt, members: [] });
    if (row.userId) grouped.get(row.id).members.push({ id: row.userId, name: row.name, isTech: Boolean(row.isTech) });
  }
  const ownEnrollment = db.prepare("SELECT slots_json AS slotsJson, expected_count AS expectedCount, note, updated_at AS updatedAt FROM enrollments WHERE week_id=? AND user_id=?").get(weekId, user.id);
  const base = { id: week.id, weekStart: week.week_start, enrollmentDeadline: week.enrollment_deadline, status: week.status };
  const latestPublication = db.prepare("SELECT snapshot_json AS snapshotJson FROM schedule_publications WHERE week_id=? ORDER BY id DESC LIMIT 1").get(weekId);
  const response = { week: base, schedule: user.role === "admin" ? [...grouped.values()] : latestPublication ? JSON.parse(latestPublication.snapshotJson) : [], ownEnrollment: ownEnrollment ? { ...ownEnrollment, slots: JSON.parse(ownEnrollment.slotsJson) } : null };

  if (user.role === "admin") {
    response.schedule = [...grouped.values()];
    response.members = db.prepare("SELECT id, username, display_name AS name, is_tech AS isTech, active FROM users WHERE role='student' ORDER BY display_name").all().map(member => ({ ...member, isTech: Boolean(member.isTech), active: Boolean(member.active) }));
    response.enrollments = db.prepare(`SELECT e.user_id AS userId, u.display_name AS name, u.is_tech AS isTech, e.slots_json AS slotsJson, e.expected_count AS expectedCount, e.note, e.updated_at AS updatedAt FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.week_id=? ORDER BY u.display_name`).all(weekId).map(row => ({ ...row, isTech: Boolean(row.isTech), slots: JSON.parse(row.slotsJson) }));
    response.requests = db.prepare(`SELECT r.id, r.type, r.reason, r.status, r.submitted_at AS submittedAt, u.id AS userId, u.display_name AS name, s.id AS shiftId, s.day_index AS dayIndex, s.period, s.starts_at AS startsAt FROM requests r JOIN users u ON u.id=r.user_id JOIN shifts s ON s.id=r.shift_id WHERE r.week_id=? ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.submitted_at DESC`).all(weekId).map(row => ({ ...row, day: DAYS[row.dayIndex] }));
    response.audit = db.prepare("SELECT a.action, a.object_type AS objectType, a.details_json AS detailsJson, a.created_at AS createdAt, u.display_name AS actorName FROM audit_logs a JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 20").all().map(row => ({ ...row, details: JSON.parse(row.detailsJson) }));
    response.versions = db.prepare("SELECT p.id,p.created_at AS createdAt,u.display_name AS publisher FROM schedule_publications p JOIN users u ON u.id=p.published_by WHERE p.week_id=? ORDER BY p.id DESC LIMIT 10").all(weekId);
  } else {
    response.requests = db.prepare(`SELECT r.id, r.type, r.reason, r.status, r.submitted_at AS submittedAt, s.day_index AS dayIndex, s.period, s.starts_at AS startsAt FROM requests r JOIN shifts s ON s.id=r.shift_id WHERE r.week_id=? AND r.user_id=? ORDER BY r.submitted_at DESC`).all(weekId, user.id).map(row => ({ ...row, day: DAYS[row.dayIndex] }));
  }
  return response;
}

function writeAudit(actorId, action, objectType, objectId, details = {}) {
  db.prepare("INSERT INTO audit_logs(actor_id,action,object_type,object_id,details_json) VALUES(?,?,?,?,?)").run(actorId, action, objectType, String(objectId), JSON.stringify(details));
}

function captureSchedule(weekId) {
  const shifts = db.prepare(`SELECT s.id,s.day_index AS dayIndex,s.period,s.starts_at AS startsAt,s.ends_at AS endsAt,u.id AS userId,u.display_name AS name,u.is_tech AS isTech FROM shifts s LEFT JOIN assignments a ON a.shift_id=s.id LEFT JOIN users u ON u.id=a.user_id AND u.active=1 WHERE s.week_id=? ORDER BY s.day_index,CASE s.period WHEN '上午' THEN 0 ELSE 1 END,a.position,u.display_name`).all(weekId);
  const grouped = new Map();
  for (const row of shifts) {
    if (!grouped.has(row.id)) grouped.set(row.id, { id: row.id, dayIndex: row.dayIndex, day: DAYS[row.dayIndex], period: row.period, startsAt: row.startsAt, endsAt: row.endsAt, members: [] });
    if (row.userId) grouped.get(row.id).members.push({ id: row.userId, name: row.name, isTech: Boolean(row.isTech) });
  }
  return [...grouped.values()];
}

function publishSnapshot(weekId, userId) {
  const snapshot = captureSchedule(weekId);
  const result = db.prepare("INSERT INTO schedule_publications(week_id,published_by,snapshot_json) VALUES(?,?,?)").run(weekId, userId, JSON.stringify(snapshot));
  db.prepare("UPDATE weeks SET status='published' WHERE id=?").run(weekId);
  return Number(result.lastInsertRowid);
}

function nextWeekId() {
  return db.prepare("SELECT id FROM weeks ORDER BY week_start DESC LIMIT 1").get().id;
}

function allShifts(weekId) {
  return db.prepare("SELECT * FROM shifts WHERE week_id=? ORDER BY day_index, CASE period WHEN '上午' THEN 0 ELSE 1 END").all(weekId);
}

function autoArrange(weekId) {
  const people = db.prepare("SELECT u.id,u.display_name AS name,u.is_tech AS isTech,e.expected_count AS expectedCount,e.slots_json AS slotsJson FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.week_id=? AND u.active=1").all(weekId).map(person => ({ ...person, isTech: Boolean(person.isTech), slots: JSON.parse(person.slotsJson), assigned: new Set() }));
  const shifts = allShifts(weekId).map(shift => ({ ...shift, members: [] }));
  const key = shift => `${DAYS[shift.day_index]}-${shift.period}`;
  const available = (person, shift) => person.slots.includes(key(shift)) && person.assigned.size < person.expectedCount && !shift.members.some(item => item.id === person.id);
  const sameDayFree = (person, shift) => !person.assigned.has(`${shift.day_index}-上午`) || !person.assigned.has(`${shift.day_index}-下午`);
  for (const shift of shifts) {
    const techs = people.filter(person => person.isTech && available(person, shift));
    const tech = techs.find(sameDayFree) || techs[0];
    if (tech) { shift.members.push(tech); tech.assigned.add(`${shift.day_index}-${shift.period}`); }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const shift of [...shifts].sort((a, b) => a.members.length - b.members.length)) {
      if (shift.members.length >= MAX_PER_SHIFT) continue;
      const candidates = people.filter(person => !person.isTech && available(person, shift));
      const candidate = candidates.find(sameDayFree) || candidates[0];
      if (!candidate) continue;
      shift.members.push(candidate);
      candidate.assigned.add(`${shift.day_index}-${shift.period}`);
      changed = true;
    }
  }
  const replace = db.prepare("DELETE FROM assignments WHERE shift_id=?");
  const assign = db.prepare("INSERT INTO assignments(shift_id,user_id,position) VALUES(?,?,?)");
  const commit = db.transaction(() => {
    for (const shift of shifts) {
      replace.run(shift.id);
      shift.members.sort((a, b) => Number(b.isTech) - Number(a.isTech) || a.name.localeCompare(b.name, "zh-CN"));
      shift.members.forEach((person, index) => assign.run(shift.id, person.id, index));
    }
  });
  commit();
  return { shifts: shifts.length, assigned: shifts.reduce((sum, shift) => sum + shift.members.length, 0), uncovered: shifts.filter(shift => !shift.members.length).length, withoutTech: shifts.filter(shift => shift.members.length && !shift.members.some(person => person.isTech)).length };
}

async function handleApi(req, res, url) {
  const method = req.method;
  const path = url.pathname;
  if (method === "GET" && path === "/api/session") {
    const user = currentUser(req);
    return send(res, 200, { user: user ? publicUser(user) : null, needsSetup: !db.prepare("SELECT id FROM users LIMIT 1").get() });
  }
  if (method === "POST" && path === "/api/setup") {
    const body = await readJson(req);
    const name = requireText(body.name, "管理员姓名", 60);
    const username = requireText(body.username, "账号", 40);
    const password = requireText(body.password, "密码", 200);
    if (password.length < 10) throw Object.assign(new Error("管理员密码至少需要 10 位"), { status: 400 });
    const { salt, hash } = hashPassword(password);
    let result;
    try {
      result = db.transaction(() => {
        if (db.prepare("SELECT id FROM users LIMIT 1").get()) throw Object.assign(new Error("管理员已初始化，请直接登录"), { status: 409 });
        return db.prepare("INSERT INTO users(username,display_name,role,password_hash,salt) VALUES(?,?,'admin',?,?)").run(username, name, hash, salt);
      })();
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("账号已存在"), { status: 409 });
      throw error;
    }
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { userId: Number(result.lastInsertRowid), expiresAt: Date.now() + SESSION_MS });
    setSessionCookie(res, token);
    return send(res, 201, { user: publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(Number(result.lastInsertRowid))) });
  }
  if (method === "POST" && path === "/api/login") {
    const body = await readJson(req);
    const username = requireText(body.username, "账号", 40);
    const password = String(body.password || "");
    const user = db.prepare("SELECT * FROM users WHERE username=? AND active=1").get(username);
    if (!user) return send(res, 401, { error: "账号或密码不正确" });
    const expected = Buffer.from(user.password_hash, "hex");
    const actual = Buffer.from(hashPassword(password, user.salt).hash, "hex");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return send(res, 401, { error: "账号或密码不正确" });
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_MS });
    setSessionCookie(res, token);
    return send(res, 200, { user: publicUser(user) });
  }
  if (method === "POST" && path === "/api/logout") {
    const token = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith("ih_session="))?.slice("ih_session=".length);
    if (token) sessions.delete(token);
    clearSessionCookie(res);
    return send(res, 200, { ok: true });
  }

  const user = currentUser(req);
  requireUser(user);

  if (method === "GET" && path === "/api/bootstrap") {
    const weekId = Number(url.searchParams.get("week") || nextWeekId());
    const weeks = db.prepare("SELECT id,week_start AS weekStart,enrollment_deadline AS enrollmentDeadline,status FROM weeks ORDER BY week_start DESC").all();
    return send(res, 200, { ...weekPayload(weekId, user), weeks, user: publicUser(user) });
  }

  if (method === "PUT" && path === "/api/enrollment") {
    if (user.role !== "student") throw Object.assign(new Error("只有普通成员可以提交空闲报名"), { status: 403 });
    const body = await readJson(req);
    const weekId = Number(body.weekId || nextWeekId());
    const week = db.prepare("SELECT * FROM weeks WHERE id=?").get(weekId);
    if (!week) throw Object.assign(new Error("找不到该周次"), { status: 404 });
    if (Date.now() > new Date(week.enrollment_deadline).getTime()) throw Object.assign(new Error("报名已截止，请联系管理员"), { status: 409 });
    const allowed = new Set(allShifts(weekId).map(shift => `${DAYS[shift.day_index]}-${shift.period}`));
    const slots = [...new Set(Array.isArray(body.slots) ? body.slots : [])];
    if (!slots.length || slots.some(slot => !allowed.has(slot))) throw Object.assign(new Error("请选择有效的空闲班次"), { status: 400 });
    const expectedCount = Number(body.expectedCount);
    if (!Number.isInteger(expectedCount) || expectedCount < 1 || expectedCount > slots.length) throw Object.assign(new Error("期望次数必须在 1 到所选时段数之间"), { status: 400 });
    db.prepare(`INSERT INTO enrollments(week_id,user_id,slots_json,expected_count,note,updated_at) VALUES(?,?,?,?,?,datetime('now')) ON CONFLICT(week_id,user_id) DO UPDATE SET slots_json=excluded.slots_json,expected_count=excluded.expected_count,note=excluded.note,updated_at=datetime('now')`).run(weekId, user.id, JSON.stringify(slots), expectedCount, String(body.note || "").slice(0, 500));
    writeAudit(user.id, "submit_enrollment", "week", weekId, { count: slots.length });
    return send(res, 200, { ok: true });
  }

  if (method === "POST" && path === "/api/requests") {
    if (user.role !== "student") throw Object.assign(new Error("只有普通成员可以提交申请"), { status: 403 });
    const body = await readJson(req);
    const shiftId = Number(body.shiftId);
    const shift = db.prepare("SELECT s.*,w.status FROM shifts s JOIN weeks w ON w.id=s.week_id WHERE s.id=?").get(shiftId);
    if (!shift || shift.status !== "published") throw Object.assign(new Error("该班次不存在或尚未发布"), { status: 400 });
    if (!new Set(["请假", "补班"]).has(body.type)) throw Object.assign(new Error("申请类型无效"), { status: 400 });
    const assigned = Boolean(db.prepare("SELECT 1 FROM assignments WHERE shift_id=? AND user_id=?").get(shiftId, user.id));
    if (body.type === "请假" && !assigned) throw Object.assign(new Error("请假申请只能针对你当前所在的班次"), { status: 400 });
    if (body.type === "补班" && assigned) throw Object.assign(new Error("你已在该班次中，无需申请补班"), { status: 400 });
    const reason = requireText(body.reason, "申请说明", 500);
    const result = db.prepare("INSERT INTO requests(week_id,user_id,shift_id,type,reason) VALUES(?,?,?,?,?)").run(shift.week_id, user.id, shiftId, body.type, reason);
    writeAudit(user.id, "submit_request", "request", result.lastInsertRowid, { type: body.type, shiftId });
    return send(res, 201, { ok: true });
  }

  if (path.startsWith("/api/admin/")) requireAdmin(user);

  if (method === "POST" && path === "/api/admin/members") {
    const body = await readJson(req);
    const name = requireText(body.name, "成员姓名", 60);
    const username = requireText(body.username, "登录账号", 40);
    const password = requireText(body.password, "初始密码", 200);
    if (password.length < 10) throw Object.assign(new Error("初始密码至少需要 10 位"), { status: 400 });
    const { salt, hash } = hashPassword(password);
    try {
      const result = db.prepare("INSERT INTO users(username,display_name,role,is_tech,password_hash,salt) VALUES(?,?,'student',?,?,?)").run(username, name, body.isTech ? 1 : 0, hash, salt);
      writeAudit(user.id, "create_member", "user", result.lastInsertRowid, { name });
      return send(res, 201, { ok: true });
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("登录账号已存在"), { status: 409 });
      throw error;
    }
  }

  if (method === "POST" && path === "/api/admin/weeks") {
    const body = await readJson(req);
    const start = requireText(body.weekStart, "周一日期", 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw Object.assign(new Error("日期格式应为 YYYY-MM-DD"), { status: 400 });
    const startDate = new Date(`${start}T12:00:00Z`);
    if (Number.isNaN(startDate.getTime()) || startDate.toISOString().slice(0, 10) !== start || startDate.getUTCDay() !== 1) throw Object.assign(new Error("周次开始日期必须是有效的周一"), { status: 400 });
    let week;
    try { week = createWeek(start, body.enrollmentDeadline || null); }
    catch (error) { if (String(error.message).includes("UNIQUE")) throw Object.assign(new Error("这个周次已存在"), { status: 409 }); throw error; }
    writeAudit(user.id, "create_week", "week", week.id, { weekStart: start });
    return send(res, 201, { week: { id: week.id, weekStart: week.week_start, enrollmentDeadline: week.enrollment_deadline, status: week.status } });
  }

  if (method === "POST" && path === "/api/admin/schedule/auto") {
    const body = await readJson(req);
    const weekId = Number(body.weekId || nextWeekId());
    const stats = autoArrange(weekId);
    writeAudit(user.id, "auto_arrange", "week", weekId, stats);
    return send(res, 200, stats);
  }

  const shiftMatch = path.match(/^\/api\/admin\/shifts\/(\d+)$/);
  if (method === "PUT" && shiftMatch) {
    const shiftId = Number(shiftMatch[1]);
    const body = await readJson(req);
    if (!Array.isArray(body.memberIds) || body.memberIds.length > MAX_PER_SHIFT || new Set(body.memberIds).size !== body.memberIds.length) throw Object.assign(new Error("每班最多 5 人，且成员不能重复"), { status: 400 });
    const ids = body.memberIds.map(Number);
    const valid = ids.length ? db.prepare(`SELECT id,is_tech FROM users WHERE role='student' AND active=1 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
    if (valid.length !== ids.length) throw Object.assign(new Error("成员列表包含无效账号"), { status: 400 });
    const ordered = ids.sort((a, b) => Number(valid.find(person => person.id === b).is_tech) - Number(valid.find(person => person.id === a).is_tech));
    const replace = db.transaction(() => {
      db.prepare("DELETE FROM assignments WHERE shift_id=?").run(shiftId);
      const insert = db.prepare("INSERT INTO assignments(shift_id,user_id,position) VALUES(?,?,?)");
      ordered.forEach((id, index) => insert.run(shiftId, id, index));
    });
    if (!db.prepare("SELECT id FROM shifts WHERE id=?").get(shiftId)) throw Object.assign(new Error("找不到该班次"), { status: 404 });
    replace();
    writeAudit(user.id, "edit_shift", "shift", shiftId, { memberIds: ordered });
    return send(res, 200, { ok: true });
  }

  const requestMatch = path.match(/^\/api\/admin\/requests\/(\d+)$/);
  if (method === "PATCH" && requestMatch) {
    const requestId = Number(requestMatch[1]);
    const body = await readJson(req);
    if (!new Set(["approved", "rejected"]).has(body.status)) throw Object.assign(new Error("审批状态无效"), { status: 400 });
    const request = db.prepare("SELECT * FROM requests WHERE id=?").get(requestId);
    if (!request) throw Object.assign(new Error("找不到该申请"), { status: 404 });
    if (request.status !== "pending") throw Object.assign(new Error("该申请已经处理"), { status: 409 });
    const publicationId = db.transaction(() => {
      if (body.status === "approved" && request.type === "补班") {
        const count = db.prepare("SELECT COUNT(*) AS total FROM assignments WHERE shift_id=?").get(request.shift_id).total;
        if (count >= MAX_PER_SHIFT) throw Object.assign(new Error("该班次已满员，请先调整排班再批准补班"), { status: 409 });
        db.prepare("INSERT OR IGNORE INTO assignments(shift_id,user_id,position) VALUES(?,?,?)").run(request.shift_id, request.user_id, count);
      }
      if (body.status === "approved" && request.type === "请假") db.prepare("DELETE FROM assignments WHERE shift_id=? AND user_id=?").run(request.shift_id, request.user_id);
      db.prepare("UPDATE requests SET status=?,reviewed_at=datetime('now'),reviewed_by=? WHERE id=?").run(body.status, user.id, requestId);
      const publication = body.status === "approved" ? publishSnapshot(request.week_id, user.id) : null;
      writeAudit(user.id, body.status === "approved" ? "approve_request" : "reject_request", "request", requestId, { type: request.type, publicationId: publication });
      return publication;
    })();
    return send(res, 200, { ok: true });
  }

  const publishMatch = path.match(/^\/api\/admin\/weeks\/(\d+)\/publish$/);
  if (method === "POST" && publishMatch) {
    const weekId = Number(publishMatch[1]);
    if (!db.prepare("SELECT id FROM weeks WHERE id=?").get(weekId)) throw Object.assign(new Error("找不到该周次"), { status: 404 });
    const publicationId = publishSnapshot(weekId, user.id);
    writeAudit(user.id, "publish_week", "week", weekId, { publicationId });
    return send(res, 200, { ok: true, publicationId });
  }

  if (method === "GET" && path === "/api/admin/audit") {
    return send(res, 200, db.prepare("SELECT a.action,a.object_type AS objectType,a.object_id AS objectId,a.details_json AS detailsJson,a.created_at AS createdAt,u.display_name AS actorName FROM audit_logs a JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200").all().map(row => ({ ...row, details: JSON.parse(row.detailsJson) })));
  }

  return send(res, 404, { error: "找不到接口" });
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const PUBLIC_FILES = new Set(["index.html", "styles.css", "app.js"]);
function serveStatic(req, res, pathname) {
  const requested = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const relative = normalize(requested).replace(/^[/\\]+/, "");
  if (!PUBLIC_FILES.has(relative)) return send(res, 404, { error: "找不到页面" });
  const target = resolve(ROOT, relative);
  if (!target.startsWith(ROOT + sep)) return send(res, 403, { error: "禁止访问" });
  if (!existsSync(target)) return send(res, 404, { error: "找不到页面" });
  const content = readFileSync(target);
  res.writeHead(200, { "Content-Type": MIME[extname(target)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" });
  res.end(content);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else if (req.method === "GET" || req.method === "HEAD") serveStatic(req, res, url.pathname);
    else send(res, 405, { error: "不支持该请求方法" });
  } catch (error) {
    if (res.headersSent || res.writableEnded) return;
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    send(res, status, { error: status >= 500 ? "服务器暂时无法处理请求" : error.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`铁马驿站排班中心已启动： http://localhost:${PORT}`);
  console.log(`数据文件：${DB_FILE}`);
  if (!db.prepare("SELECT id FROM users LIMIT 1").get()) console.log("首次启动：打开网页创建管理员账号。");
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

