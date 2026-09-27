const WEEKDAY_LABELS = ["日", "一", "二", "三", "四", "五", "六"];

function cellText(html) {
  return html
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, value) => String.fromCodePoint(Number(value)))
    .replace(/&#x([\da-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/\s+/g, " ")
    .trim();
}

function parseTableRows(html) {
  const table = html.match(/<table\b[^>]*>([\s\S]*?)<\/table\s*>/i)?.[1];
  if (!table) throw new Error("文件中没有找到考勤统计表");
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr\s*>/gi)].map((row) =>
    [...row[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)\s*>/gi)].map((cell) => cellText(cell[1]))
  );
}

function isoUtcDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("请填写报表第一天的日期");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("报表第一天不是有效日期");
  return date;
}

function addDays(date, days) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function parseDuration(value, day, name) {
  if (!value) return 0;
  const match = value.match(/^正班\s*(-?(?:\d+(?:\.\d*)?|\.\d+))$/);
  if (!match) throw new Error(`${name}在${day}的正班时长无法识别：${value}`);
  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours < 0) throw new Error(`${name}在${day}的正班时长无效`);
  return hours;
}

export function parseAttendanceReport(html, reportStartDate, weekStart) {
  if (!/<table\b/i.test(html)) throw new Error("该文件不是可识别的网页版 Excel 考勤表");
  const rows = parseTableRows(html);
  if (rows.length < 4 || !rows[0].length || rows[1].length < 2) throw new Error("考勤表结构不完整");

  const dateHeaders = rows[0].slice(3).map((label, index) => {
    const match = label.match(/^(\d{1,2})\s*([一二三四五六日天])$/);
    if (!match) throw new Error(`日期列第 ${index + 1} 列无法识别：${label || "空白"}`);
    return { day: Number(match[1]), weekday: match[2] === "天" ? "日" : match[2] };
  });
  if (dateHeaders.length < 7) throw new Error("报表中的日期列不足一周");
  if (!rows[1].some((value) => value === "正班") || !rows[1].some((value) => value === "加班")) {
    throw new Error("表格未找到“正班/加班”类别行");
  }

  const firstDate = isoUtcDate(reportStartDate);
  const selectedMonday = isoUtcDate(weekStart);
  if (selectedMonday.getUTCDay() !== 1) throw new Error("所选周次不是从周一开始");

  const dates = dateHeaders.map((header, index) => {
    const date = addDays(firstDate, index);
    const actualDay = date.getUTCDate();
    const actualWeekday = WEEKDAY_LABELS[date.getUTCDay()];
    if (header.day !== actualDay || header.weekday !== actualWeekday) {
      throw new Error(`报表日期与起始日期不符：第 ${index + 1} 个日期列应为 ${actualDay} ${actualWeekday}`);
    }
    return date.toISOString().slice(0, 10);
  });

  const weekDates = Array.from({ length: 7 }, (_, index) => addDays(selectedMonday, index).toISOString().slice(0, 10));
  const dateIndexes = weekDates.map((date) => dates.indexOf(date));
  if (dateIndexes.some((index) => index < 0)) throw new Error("报表日期范围未覆盖所选周次的完整七天");

  const records = [];
  for (let index = 2; index < rows.length; index += 2) {
    const regularRow = rows[index];
    const overtimeRow = rows[index + 1] || [];
    const name = regularRow[1] || "";
    const employeeId = overtimeRow[0] || "";
    if (!name && !employeeId) continue;
    if (!name || !employeeId) throw new Error(`第 ${index + 1} 行缺少姓名或工号，无法安全导入`);
    if (regularRow.length !== dateHeaders.length + 4 || overtimeRow.length !== dateHeaders.length + 1) {
      throw new Error(`${name}的正班/加班数据列数与日期列不一致`);
    }
    const daily = dateIndexes.map((columnIndex, dayIndex) => ({
      date: weekDates[dayIndex],
      hours: parseDuration(regularRow[columnIndex + 4], weekDates[dayIndex], name),
    }));
    records.push({ employeeId, name, daily, totalHours: daily.reduce((sum, item) => sum + item.hours, 0) });
  }
  if (!records.length) throw new Error("报表中没有找到队员工时记录");
  return { reportStartDate, weekStart, weekDates, records };
}
