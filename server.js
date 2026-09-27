import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DB_FILE = resolve(process.env.DB_PATH || join(ROOT, "data", "iron-horse.sqlite"));
const SESSION_MS = 1000 * 60 * 60 * 24 * 14;
const sessions = new Map();
mkdirSync(join(DB_FILE, ".."), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");

function transaction(callback) {
  return (...args) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback(...args);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
}

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
  return weekWindowStarts()[0];
}

function weekWindowStarts() {
  const monday = new Date(`${shanghaiDate()}T12:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const current = monday.toISOString().slice(0, 10);
  monday.setUTCDate(monday.getUTCDate() + 7);
  return [current, monday.toISOString().slice(0, 10)];
}

function defaultEnrollmentDeadline(weekStart) {
  const [year, month, day] = weekStart.split("-").map(Number);
  const deadlineDate = new Date(Date.UTC(year, month - 1, day, 4));
  deadlineDate.setUTCDate(deadlineDate.getUTCDate() - 1);
  return `${deadlineDate.toISOString().slice(0, 10)}T20:00:00+08:00`;
}

function createWeek(weekStart, deadline = null) {
  const cutoff = deadline || defaultEnrollmentDeadline(weekStart);
  const result = db.prepare("INSERT INTO weeks (week_start, enrollment_deadline) VALUES (?, ?)").run(weekStart, cutoff);
  const weekId = Number(result.lastInsertRowid);
  const insertShift = db.prepare("INSERT INTO shifts (week_id, day_index, period, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)");
  const insertMany = transaction(() => {
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      insertShift.run(weekId, dayIndex, "下午", "16:30", "18:30");
      insertShift.run(weekId, dayIndex, "上午", "18:30", "20:30");
    }
  });
  insertMany();
  return db.prepare("SELECT * FROM weeks WHERE id = ?").get(weekId);
}

function ensureWeekShifts(weekId) {
  const insertShift = db.prepare("INSERT INTO shifts (week_id, day_index, period, starts_at, ends_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(week_id, day_index, period) DO NOTHING");
  transaction(() => {
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      insertShift.run(weekId, dayIndex, "下午", "16:30", "18:30");
      insertShift.run(weekId, dayIndex, "上午", "18:30", "20:30");
    }
  })();
}

function replaceWithStandardWeekShifts(weekId) {
  const insertShift = db.prepare("INSERT INTO shifts (week_id, day_index, period, starts_at, ends_at) VALUES (?, ?, ?, ?, ?)");
  transaction(() => {
    db.prepare("DELETE FROM shifts WHERE week_id=?").run(weekId);
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      insertShift.run(weekId, dayIndex, "下午", "16:30", "18:30");
      insertShift.run(weekId, dayIndex, "上午", "18:30", "20:30");
    }
  })();
}

function standardizeWeekShiftTimes(weekId) {
  const updateShift = db.prepare("UPDATE shifts SET starts_at=?,ends_at=? WHERE id=?");
  transaction(() => {
    for (let dayIndex = 0; dayIndex < 7; dayIndex++) {
      const dayShifts = db.prepare("SELECT id FROM shifts WHERE week_id=? AND day_index=? ORDER BY starts_at,id").all(weekId, dayIndex);
      if (dayShifts.length !== 2) continue;
      updateShift.run("16:30", "18:30", dayShifts[0].id);
      updateShift.run("18:30", "20:30", dayShifts[1].id);
    }
  })();
}

if (!db.prepare("SELECT id FROM weeks LIMIT 1").get()) createWeek(defaultWeekStart());
for (const week of db.prepare("SELECT id FROM weeks w WHERE NOT EXISTS (SELECT 1 FROM shifts s WHERE s.week_id=w.id)").all()) {
  ensureWeekShifts(week.id);
}

function ensureWeekWindow() {
  const starts = weekWindowStarts();
  for (const weekStart of starts) {
    let week = db.prepare("SELECT id FROM weeks WHERE week_start=?").get(weekStart);
    if (!week) week = createWeek(weekStart);
    const weekId = week.id;
    db.prepare("UPDATE weeks SET enrollment_deadline=? WHERE id=?").run(defaultEnrollmentDeadline(weekStart), weekId);
    const hasData = db.prepare(`SELECT
      EXISTS(SELECT 1 FROM enrollments WHERE week_id=?) OR
      EXISTS(SELECT 1 FROM assignments a JOIN shifts s ON s.id=a.shift_id WHERE s.week_id=?) OR
      EXISTS(SELECT 1 FROM requests WHERE week_id=?) OR
      EXISTS(SELECT 1 FROM schedule_publications WHERE week_id=?) AS value`).get(weekId, weekId, weekId, weekId).value;
    const existingShifts = db.prepare("SELECT day_index AS dayIndex,period,starts_at AS startsAt,ends_at AS endsAt FROM shifts WHERE week_id=?").all(weekId);
    const slotsByDay = Array.from({ length: 7 }, (_, dayIndex) => existingShifts.filter(shift => shift.dayIndex === dayIndex));
    const alreadyStandard = existingShifts.length === 14 && slotsByDay.every(slots =>
      slots.length === 2 && slots.some(slot => slot.startsAt === "16:30" && slot.endsAt === "18:30") &&
      slots.some(slot => slot.startsAt === "18:30" && slot.endsAt === "20:30"));
    if (!hasData && !alreadyStandard) {
      replaceWithStandardWeekShifts(weekId);
    } else {
      ensureWeekShifts(weekId);
      if (hasData && !alreadyStandard) standardizeWeekShiftTimes(weekId);
    }
    if (hasData && !alreadyStandard && db.prepare("SELECT status FROM weeks WHERE id=?").get(weekId).status === "published") {
      const latestPublication = db.prepare("SELECT id FROM schedule_publications WHERE week_id=? ORDER BY id DESC LIMIT 1").get(weekId);
      if (latestPublication) db.prepare("UPDATE schedule_publications SET snapshot_json=? WHERE id=?").run(JSON.stringify(captureSchedule(weekId)), latestPublication.id);
    }
  }
  return starts.map(weekStart => db.prepare("SELECT id,week_start AS weekStart,enrollment_deadline AS enrollmentDeadline,status FROM weeks WHERE week_start=?").get(weekStart));
}

function adminWeekOptions(windowWeeks) {
  const current = windowWeeks.map((week, index) => ({ ...week, kind: index === 0 ? "current" : "next" }));
  const historical = db.prepare(`
    SELECT w.id,w.week_start AS weekStart,w.enrollment_deadline AS enrollmentDeadline,w.status,
      EXISTS(SELECT 1 FROM enrollments e WHERE e.week_id=w.id) AS hasEnrollment,
      EXISTS(SELECT 1 FROM schedule_publications p WHERE p.week_id=w.id) AS hasPublication
    FROM weeks w
    WHERE w.week_start < ? AND (
      EXISTS(SELECT 1 FROM enrollments e WHERE e.week_id=w.id) OR
      EXISTS(SELECT 1 FROM schedule_publications p WHERE p.week_id=w.id)
    )
    ORDER BY w.week_start DESC
  `).all(windowWeeks[0].weekStart).map(week => ({ ...week, kind: "history", hasEnrollment: Boolean(week.hasEnrollment), hasPublication: Boolean(week.hasPublication) }));
  return [...current, ...historical];
}

ensureWeekWindow();
normalizeExistingAssignmentOrder();

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
      u.id AS userId, u.display_name AS name, u.is_tech AS isTech, a.position AS position
    FROM shifts s LEFT JOIN assignments a ON a.shift_id=s.id
    LEFT JOIN users u ON u.id=a.user_id AND u.active=1
    WHERE s.week_id=? ORDER BY s.day_index, s.starts_at, a.position, u.display_name
  `).all(weekId);
  const grouped = new Map();
  for (const row of shifts) {
    if (!grouped.has(row.id)) grouped.set(row.id, { id: row.id, dayIndex: row.dayIndex, day: DAYS[row.dayIndex], period: row.period, startsAt: row.startsAt, endsAt: row.endsAt, members: [] });
    if (row.userId) grouped.get(row.id).members.push({ id: row.userId, name: row.name, isTech: Boolean(row.isTech), position: row.position });
  }
  for (const shift of grouped.values()) shift.techSlotOpen = !shift.members.some(member => member.isTech && member.position === 0);
  const ownEnrollment = db.prepare("SELECT slots_json AS slotsJson, expected_count AS expectedCount, note, updated_at AS updatedAt FROM enrollments WHERE week_id=? AND user_id=?").get(weekId, user.id);
  const base = { id: week.id, weekStart: week.week_start, enrollmentDeadline: week.enrollment_deadline, status: week.status };
  const slotOptions = db.prepare("SELECT day_index AS dayIndex,period,starts_at AS startsAt,ends_at AS endsAt FROM shifts WHERE week_id=? ORDER BY day_index,starts_at").all(weekId).map(slot => ({ ...slot, day: DAYS[slot.dayIndex], key: `${DAYS[slot.dayIndex]}-${slot.period}` }));
  const latestPublication = db.prepare("SELECT snapshot_json AS snapshotJson FROM schedule_publications WHERE week_id=? ORDER BY id DESC LIMIT 1").get(weekId);
  const response = { week: base, slotOptions, schedule: user.role === "admin" ? [...grouped.values()] : latestPublication ? JSON.parse(latestPublication.snapshotJson) : [], ownEnrollment: ownEnrollment ? { ...ownEnrollment, slots: JSON.parse(ownEnrollment.slotsJson) } : null };

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
  const shifts = db.prepare(`SELECT s.id,s.day_index AS dayIndex,s.period,s.starts_at AS startsAt,s.ends_at AS endsAt,u.id AS userId,u.display_name AS name,u.is_tech AS isTech,a.position AS position FROM shifts s LEFT JOIN assignments a ON a.shift_id=s.id LEFT JOIN users u ON u.id=a.user_id AND u.active=1 WHERE s.week_id=? ORDER BY s.day_index,s.starts_at,a.position,u.display_name`).all(weekId);
  const grouped = new Map();
  for (const row of shifts) {
    if (!grouped.has(row.id)) grouped.set(row.id, { id: row.id, dayIndex: row.dayIndex, day: DAYS[row.dayIndex], period: row.period, startsAt: row.startsAt, endsAt: row.endsAt, members: [] });
    if (row.userId) grouped.get(row.id).members.push({ id: row.userId, name: row.name, isTech: Boolean(row.isTech), position: row.position });
  }
  for (const shift of grouped.values()) shift.techSlotOpen = !shift.members.some(member => member.isTech && member.position === 0);
  return [...grouped.values()];
}

function publishSnapshot(weekId, userId) {
  const snapshot = captureSchedule(weekId);
  const result = db.prepare("INSERT INTO schedule_publications(week_id,published_by,snapshot_json) VALUES(?,?,?)").run(weekId, userId, JSON.stringify(snapshot));
  db.prepare("UPDATE weeks SET status='published' WHERE id=?").run(weekId);
  return Number(result.lastInsertRowid);
}

function normalizeExistingAssignmentOrder() {
  const shiftIds = db.prepare("SELECT DISTINCT shift_id AS shiftId FROM assignments").all().map(row => row.shiftId);
  const changedWeeks = new Set();
  transaction(() => {
    for (const shiftId of shiftIds) {
      if (normalizeShiftAssignmentOrder(shiftId)) {
        const week = db.prepare("SELECT week_id AS weekId FROM shifts WHERE id=?").get(shiftId);
        if (week) changedWeeks.add(week.weekId);
      }
    }
  })();
  for (const weekId of changedWeeks) {
    const latest = db.prepare("SELECT id FROM schedule_publications WHERE week_id=? ORDER BY id DESC LIMIT 1").get(weekId);
    if (latest) db.prepare("UPDATE schedule_publications SET snapshot_json=? WHERE id=?").run(JSON.stringify(captureSchedule(weekId)), latest.id);
  }
}

function normalizeShiftAssignmentOrder(shiftId) {
  const rows = db.prepare("SELECT a.user_id AS userId,a.position,u.is_tech AS isTech,u.display_name AS name FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.shift_id=? ORDER BY a.position,u.display_name").all(shiftId).map(row => ({ ...row, isTech: Boolean(row.isTech) }));
  const technicians = rows.filter(row => row.isTech);
  const interns = rows.filter(row => !row.isTech);
  const existingLead = technicians.find(row => row.position === 0);
  const orderedTechs = technicians.filter(row => row.userId !== existingLead?.userId);
  if (existingLead) orderedTechs.unshift(existingLead);
  const ordered = [...orderedTechs, ...interns];
  const startPosition = orderedTechs.length ? 0 : 1;
  let changed = false;
  const update = db.prepare("UPDATE assignments SET position=? WHERE shift_id=? AND user_id=?");
  ordered.forEach((row, index) => {
    const position = startPosition + index;
    if (row.position !== position) {
      update.run(position, shiftId, row.userId);
      changed = true;
    }
  });
  return changed;
}

function currentWeekId() {
  const currentWeekStart = weekWindowStarts()[0];
  return db.prepare("SELECT id FROM weeks WHERE week_start=?").get(currentWeekStart)?.id ?? ensureWeekWindow()[0].id;
}

function allShifts(weekId) {
  return db.prepare("SELECT * FROM shifts WHERE week_id=? ORDER BY day_index, starts_at").all(weekId);
}

function autoArrange(weekId) {
  const people = db.prepare("SELECT u.id,u.display_name AS name,u.is_tech AS isTech,e.expected_count AS expectedCount,e.slots_json AS slotsJson FROM enrollments e JOIN users u ON u.id=e.user_id WHERE e.week_id=? AND u.active=1 ORDER BY u.id").all(weekId).map(person => ({ ...person, isTech: Boolean(person.isTech), expectedCount: Number(person.expectedCount), slots: JSON.parse(person.slotsJson), assigned: new Set() }));
  const shifts = allShifts(weekId).map(shift => ({ ...shift, members: [], tech: null }));
  const key = shift => `${DAYS[shift.day_index]}-${shift.period}`;
  const available = (person, shift) => person.slots.includes(key(shift)) && person.assigned.size < person.expectedCount && !shift.members.some(item => item.id === person.id);
  const sameDayFree = (person, shift) => {
    const otherPeriod = shift.period === "上午" ? "下午" : "上午";
    return !person.assigned.has(`${shift.day_index}-${otherPeriod}`);
  };

  // Reserve position 0 for a formal technician before filling regular places.
  for (const shift of shifts) {
    const techs = people.filter(person => person.isTech && available(person, shift));
    const preferred = techs.filter(sameDayFree);
    const candidates = preferred.length ? preferred : techs;
    const tech = candidates.reduce((best, person) => !best || person.assigned.size < best.assigned.size ? person : best, null);
    if (tech) {
      const slot = { ...tech, position: 0 };
      shift.tech = slot;
      shift.members.push(slot);
      tech.assigned.add(`${shift.day_index}-${shift.period}`);
    }
  }

  const remainingCapacity = people.reduce((sum, person) => sum + Math.max(0, person.expectedCount - person.assigned.size), 0);
  for (let attempt = 0; attempt < remainingCapacity * 2; attempt++) {
    const availablePeople = people.filter(person => person.assigned.size < person.expectedCount);
    const eligibleShifts = shifts.filter(shift => shift.members.length - (shift.tech ? 1 : 0) < MAX_PER_SHIFT - 1);
    if (!availablePeople.length || !eligibleShifts.length) break;
    eligibleShifts.sort((a, b) => (a.members.length - (a.tech ? 1 : 0)) - (b.members.length - (b.tech ? 1 : 0)));
    let placed = false;
    for (const shift of eligibleShifts) {
      const canAssign = availablePeople.filter(person => available(person, shift));
      const formalTechnicians = canAssign.filter(person => person.isTech);
      const priorityPool = formalTechnicians.length ? formalTechnicians : canAssign;
      const preferred = priorityPool.filter(sameDayFree);
      const candidates = preferred.length ? preferred : priorityPool;
      const person = candidates.reduce((best, candidate) => {
        const candidateRatio = candidate.expectedCount > 0 ? candidate.assigned.size / candidate.expectedCount : 1;
        const bestRatio = best && best.expectedCount > 0 ? best.assigned.size / best.expectedCount : 1;
        return !best || candidateRatio < bestRatio ? candidate : best;
      }, null);
      if (!person) continue;
      shift.members.push({ ...person, position: shift.members.length + (shift.tech ? 0 : 1) });
      person.assigned.add(`${shift.day_index}-${shift.period}`);
      placed = true;
      break;
    }
    if (!placed) break;
  }

  const replace = db.prepare("DELETE FROM assignments WHERE shift_id=?");
  const assign = db.prepare("INSERT INTO assignments(shift_id,user_id,position) VALUES(?,?,?)");
  const commit = transaction(() => {
    for (const shift of shifts) {
      replace.run(shift.id);
      shift.members.forEach(person => assign.run(shift.id, person.id, person.position));
    }
  });
  commit();
  return { shifts: shifts.length, assigned: shifts.reduce((sum, shift) => sum + shift.members.length, 0), uncovered: shifts.filter(shift => !shift.members.length).length, withoutTech: shifts.filter(shift => !shift.tech).length };
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
      result = transaction(() => {
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
    const windowWeeks = ensureWeekWindow();
    const weeks = user.role === "admin"
      ? adminWeekOptions(windowWeeks)
      : windowWeeks.map((week, index) => ({ ...week, kind: index === 0 ? "current" : "next" }));
    const requestedWeekId = Number(url.searchParams.get("week") || weeks[0].id);
    const weekId = weeks.some(week => week.id === requestedWeekId) ? requestedWeekId : weeks[0].id;
    return send(res, 200, { ...weekPayload(weekId, user), weeks, user: publicUser(user) });
  }

  if (method === "PUT" && path === "/api/enrollment") {
    if (user.role !== "student") throw Object.assign(new Error("只有普通成员可以提交空闲报名"), { status: 403 });
    const body = await readJson(req);
    const weekId = Number(body.weekId || currentWeekId());
    const week = db.prepare("SELECT * FROM weeks WHERE id=?").get(weekId);
    if (!week) throw Object.assign(new Error("找不到该周次"), { status: 404 });
    if (Date.now() > new Date(week.enrollment_deadline).getTime()) throw Object.assign(new Error("报名已截止，请联系管理员"), { status: 409 });
    const allowed = new Set(allShifts(weekId).map(shift => `${DAYS[shift.day_index]}-${shift.period}`));
    const slots = [...new Set(Array.isArray(body.slots) ? body.slots : [])];
    if (!slots.length || slots.some(slot => !allowed.has(slot))) throw Object.assign(new Error("请选择有效的空闲班次"), { status: 400 });
    const expectedCount = Number(body.expectedCount);
    if (!Number.isInteger(expectedCount) || expectedCount < 0 || expectedCount > slots.length) throw Object.assign(new Error("期望次数必须在 0 到所选时段数之间"), { status: 400 });
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

  const memberTechMatch = path.match(/^\/api\/admin\/members\/(\d+)\/technician$/);
  if (method === "PATCH" && memberTechMatch) {
    const body = await readJson(req);
    if (typeof body.isTech !== "boolean") throw Object.assign(new Error("正式技师状态无效"), { status: 400 });
    const memberId = Number(memberTechMatch[1]);
    const member = db.prepare("SELECT id,display_name,is_tech AS isTech FROM users WHERE id=? AND role='student'").get(memberId);
    if (!member) throw Object.assign(new Error("找不到普通成员账号"), { status: 404 });
    if (Boolean(member.isTech) !== body.isTech) {
      db.prepare("UPDATE users SET is_tech=? WHERE id=?").run(body.isTech ? 1 : 0, memberId);
      normalizeExistingAssignmentOrder();
      writeAudit(user.id, "set_technician_status", "user", memberId, { name: member.display_name, isTech: body.isTech });
    }
    return send(res, 200, { ok: true, isTech: body.isTech });
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
    const weekId = Number(body.weekId || currentWeekId());
    const stats = autoArrange(weekId);
    writeAudit(user.id, "auto_arrange", "week", weekId, stats);
    return send(res, 200, stats);
  }

  const shiftMatch = path.match(/^\/api\/admin\/shifts\/(\d+)$/);
  if (method === "PUT" && shiftMatch) {
    const shiftId = Number(shiftMatch[1]);
    const body = await readJson(req);
    if (!Array.isArray(body.memberIds) || body.memberIds.length > MAX_PER_SHIFT || new Set(body.memberIds).size !== body.memberIds.length) throw Object.assign(new Error("成员不能重复；每班最多安排 5 人"), { status: 400 });
    const ids = body.memberIds.map(Number);
    const valid = ids.length ? db.prepare(`SELECT id,is_tech AS isTech,display_name AS name FROM users WHERE role='student' AND active=1 AND id IN (${ids.map(() => "?").join(",")})`).all(...ids) : [];
    if (valid.length !== ids.length) throw Object.assign(new Error("成员列表包含无效账号"), { status: 400 });
    const techIds = ids.filter(id => Boolean(valid.find(person => person.id === id).isTech));
    const memberById = new Map(valid.map(person => [person.id, person]));
    const previous = new Map(db.prepare("SELECT user_id AS userId,position FROM assignments WHERE shift_id=?").all(shiftId).map(row => [row.userId, row.position]));
    const stableRank = (a, b) => (previous.get(a) ?? Number.MAX_SAFE_INTEGER) - (previous.get(b) ?? Number.MAX_SAFE_INTEGER) || memberById.get(a).name.localeCompare(memberById.get(b).name, "zh-CN");
    const requestedLead = body.leadTechId === undefined || body.leadTechId === null || body.leadTechId === "" ? null : Number(body.leadTechId);
    if (requestedLead !== null && (!techIds.includes(requestedLead) || !memberById.get(requestedLead)?.isTech)) throw Object.assign(new Error("首位成员必须是本班已选的正式技师"), { status: 400 });
    const retainedLead = techIds.find(id => previous.get(id) === 0);
    const leadId = requestedLead ?? retainedLead ?? [...techIds].sort(stableRank)[0] ?? null;
    const orderedTechs = techIds.filter(id => id !== leadId).sort(stableRank);
    if (leadId !== null) orderedTechs.unshift(leadId);
    const ordered = [...orderedTechs, ...ids.filter(id => !techIds.includes(id)).sort(stableRank)];
    const replace = transaction(() => {
      db.prepare("DELETE FROM assignments WHERE shift_id=?").run(shiftId);
      const insert = db.prepare("INSERT INTO assignments(shift_id,user_id,position) VALUES(?,?,?)");
      const startPosition = orderedTechs.length ? 0 : 1;
      ordered.forEach((id, index) => insert.run(shiftId, id, startPosition + index));
    });
    if (!db.prepare("SELECT id FROM shifts WHERE id=?").get(shiftId)) throw Object.assign(new Error("找不到该班次"), { status: 404 });
    replace();
    writeAudit(user.id, "edit_shift", "shift", shiftId, { memberIds: ordered, leadTechId: leadId });
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
    const publicationId = transaction(() => {
      if (body.status === "approved" && request.type === "补班") {
        const rows = db.prepare("SELECT a.position,u.is_tech AS isTech FROM assignments a JOIN users u ON u.id=a.user_id WHERE a.shift_id=?").all(request.shift_id);
        const requester = db.prepare("SELECT is_tech AS isTech FROM users WHERE id=?").get(request.user_id);
        const hasTechSlot = rows.some(row => row.position === 0 && row.isTech);
        let position;
        if (requester.isTech && !hasTechSlot) position = 0;
        else {
          const occupied = new Set(rows.filter(row => row.position > 0).map(row => row.position));
          position = [1, 2, 3, 4].find(slot => !occupied.has(slot));
          if (position === undefined) throw Object.assign(new Error("该班次的非技师名额已满，请先调整排班再批准补班"), { status: 409 });
        }
        db.prepare("INSERT OR IGNORE INTO assignments(shift_id,user_id,position) VALUES(?,?,?)").run(request.shift_id, request.user_id, position);
      }
      if (body.status === "approved" && request.type === "请假") db.prepare("DELETE FROM assignments WHERE shift_id=? AND user_id=?").run(request.shift_id, request.user_id);
      normalizeShiftAssignmentOrder(request.shift_id);
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
    const publicationId = transaction(() => publishSnapshot(weekId, user.id))();
    writeAudit(user.id, "publish_week", "week", weekId, { publicationId });
    return send(res, 200, { ok: true, publicationId });
  }

  if (method === "GET" && path === "/api/admin/audit") {
    return send(res, 200, db.prepare("SELECT a.action,a.object_type AS objectType,a.object_id AS objectId,a.details_json AS detailsJson,a.created_at AS createdAt,u.display_name AS actorName FROM audit_logs a JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 200").all().map(row => ({ ...row, details: JSON.parse(row.detailsJson) })));
  }

  return send(res, 404, { error: "找不到接口" });
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const PUBLIC_FILES = new Set(["index.html", "styles.css", "app.js", "sw.js", "manifest.webmanifest", "icons/iron-horse.svg", "icons/iron-horse-180.png", "icons/iron-horse-192.png", "icons/iron-horse-512.png"]);
function serveStatic(req, res, pathname) {
  const requested = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const relative = normalize(requested).replace(/^[/\\]+/, "").replaceAll("\\", "/");
  if (!PUBLIC_FILES.has(relative)) return send(res, 404, { error: "找不到页面" });
  const target = resolve(ROOT, relative);
  if (!target.startsWith(resolve(ROOT) + sep)) return send(res, 403, { error: "禁止访问" });
  if (!existsSync(target)) return send(res, 404, { error: "找不到页面" });
  const content = readFileSync(target);
  const headers = { "Content-Type": MIME[extname(target)] || "application/octet-stream", "Cache-Control": relative === "sw.js" || relative === "manifest.webmanifest" || relative === "index.html" ? "no-cache" : "public, max-age=3600", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" };
  if (relative === "sw.js") headers["Service-Worker-Allowed"] = "/";
  res.writeHead(200, headers);
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

server.listen(PORT, HOST, () => {
  console.log(`铁马驿站排班中心已启动： http://localhost:${PORT}`);
  console.log(`数据文件：${DB_FILE}`);
  if (!db.prepare("SELECT id FROM users LIMIT 1").get()) console.log("首次启动：打开网页创建管理员账号。");
});

function shutdown() {
  server.close(() => { db.close(); process.exit(0); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
