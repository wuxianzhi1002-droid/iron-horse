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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) throw new Error("请选择有效的定位周次");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error("定位周次不是有效日期");
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

export function parseAttendanceReport(html, weekStart) {
  if (!/<table\b/i.test(html)) throw new Error("该文件不是可识别的网页版 Excel 考勤表");
  const rows = parseTableRows(html);
  if (rows.length < 4 || !rows[0].length || rows[1].length < 2) throw new Error("考勤表结构不完整");

  const dateHeaders = rows[0].slice(3).map((label, index) => {
    const match = label.match(/^(\d{1,2})\s*([一二三四五六日天])$/);
    if (!match) throw new Error(`日期列第 ${index + 1} 列无法识别：${label || "空白"}`);
    return { day: Number(match[1]), weekday: match[2] === "天" ? "日" : match[2] };
  });
  if (dateHeaders.length < 7 || dateHeaders.length > 200) throw new Error("报表日期范围需在 7 到 200 天之间");
  if (!rows[1].some((value) => value === "正班") || !rows[1].some((value) => value === "加班")) {
    throw new Error("表格未找到“正班/加班”类别行");
  }

  const selectedMonday = isoUtcDate(weekStart);
  if (selectedMonday.getUTCDay() !== 1) throw new Error("所选周次不是从周一开始");
  const candidates = [];
  for (let anchorIndex = 0; anchorIndex < dateHeaders.length; anchorIndex += 1) {
    if (dateHeaders[anchorIndex].weekday !== "一" || dateHeaders[anchorIndex].day !== selectedMonday.getUTCDate()) continue;
    const firstDate = addDays(selectedMonday, -anchorIndex);
    const dates = dateHeaders.map((header, index) => {
      const date = addDays(firstDate, index);
      return header.day === date.getUTCDate() && header.weekday === WEEKDAY_LABELS[date.getUTCDay()]
        ? date.toISOString().slice(0, 10)
        : null;
    });
    if (dates.every(Boolean)) candidates.push({ firstDate, dates });
  }
  if (!candidates.length) throw new Error("无法根据所选周次与报表日期、星期匹配日期范围；请选择报表覆盖到的完整周次");
  if (candidates.length > 1) throw new Error("报表日期可能对应多个年份，请缩短报表范围或确认表格中的周次");
  const { firstDate, dates } = candidates[0];
  const weekGroups = [];
  for (let index = 0; index + 6 < dates.length; index += 1) {
    const date = addDays(firstDate, index);
    if (date.getUTCDay() !== 1) continue;
    weekGroups.push({ weekStart: dates[index], dateIndexes: Array.from({ length: 7 }, (_, day) => index + day) });
  }
  if (!weekGroups.length) throw new Error("报表中没有完整的周一至周日数据");
  const anchorWeek = weekGroups.find(group => group.weekStart === weekStart);
  if (!anchorWeek) throw new Error("所选周次不在报表覆盖的完整周次内");

  const allRecords = [];
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
    const daily = dates.map((date, dayIndex) => ({
      date,
      hours: parseDuration(regularRow[dayIndex + 4], date, name),
    }));
    allRecords.push({ employeeId, name, daily });
  }
  if (!allRecords.length) throw new Error("报表中没有找到队员工时记录");
  const weeks = weekGroups.map(group => {
    const weekDates = group.dateIndexes.map(dateIndex => dates[dateIndex]);
    const records = allRecords.map(record => {
      const daily = group.dateIndexes.map(dateIndex => record.daily[dateIndex]);
      return { employeeId: record.employeeId, name: record.name, daily, totalHours: daily.reduce((sum, item) => sum + item.hours, 0) };
    });
    return { weekStart: group.weekStart, weekDates, records, totalHours: records.reduce((sum, record) => sum + record.totalHours, 0) };
  });
  const partialStart = dateHeaders.findIndex((_, index) => addDays(firstDate, index).getUTCDay() === 1);
  const lastDate = addDays(firstDate, dateHeaders.length - 1);
  const partialEnd = lastDate.getUTCDay() === 0 ? 0 : 6 - ((lastDate.getUTCDay() + 6) % 7);
  return { reportStartDate: firstDate.toISOString().slice(0, 10), weekStart, weeks, members: allRecords.map(record => ({ employeeId: record.employeeId, name: record.name })), records: anchorWeek ? weeks.find(week => week.weekStart === weekStart).records : [], partialStart, partialEnd };
}
