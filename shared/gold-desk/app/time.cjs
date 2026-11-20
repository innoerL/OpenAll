const DAY = 86_400_000;
const HALF_HOUR = 1_800_000;
const BEIJING_OFFSET = 8 * 3_600_000;
const dateAt = (milliseconds) => new Date(milliseconds + BEIJING_OFFSET).toISOString().slice(0, 10);
const scheduledAt = (date) => Date.parse(`${date}T10:00:00+08:00`);
const dateBeforeYear = (date) => {
  const year = Number(date.slice(0, 4)) - 1;
  const monthDay = date.slice(4) === '-02-29' ? '-02-28' : date.slice(4);
  return year + monthDay;
};

function latestSlot(now) {
  const today = dateAt(now);
  return now >= scheduledAt(today) ? today : dateAt(now - DAY);
}

function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

module.exports = { DAY, HALF_HOUR, dateAt, scheduledAt, dateBeforeYear, latestSlot, isDate };
