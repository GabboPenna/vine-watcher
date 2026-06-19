"use strict";

function parseTimeOfDayMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }

  return hour * 60 + minute;
}

function parseTimeWindow(value) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
  if (!match) {
    return null;
  }

  const start = parseTimeOfDayMinutes(match[1]);
  const end = parseTimeOfDayMinutes(match[2]);
  if (start === null || end === null) {
    return null;
  }

  return {
    start,
    end,
    label: `${match[1]}-${match[2]}`
  };
}

function minutesInTimeZone(nowMs = Date.now(), timeZone = "Europe/Rome") {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(nowMs));
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    if (Number.isInteger(hour) && Number.isInteger(minute)) {
      return hour * 60 + minute;
    }
  } catch (_error) {
    // Fall back to the host timezone if an invalid timezone id is configured.
  }

  const date = new Date(nowMs);
  return date.getHours() * 60 + date.getMinutes();
}

function isTimeWindowActive(value, timeZone, nowMs = Date.now()) {
  const window = parseTimeWindow(value);
  if (!window) {
    return false;
  }

  const current = minutesInTimeZone(nowMs, timeZone);
  if (window.start === window.end) {
    return true;
  }
  if (window.start < window.end) {
    return current >= window.start && current < window.end;
  }
  return current >= window.start || current < window.end;
}

module.exports = {
  isTimeWindowActive,
  minutesInTimeZone,
  parseTimeOfDayMinutes,
  parseTimeWindow
};
