/**
 * ServiceDesk stores datetimes as epoch milliseconds. Tools accept ISO dates
 * ("2026-10-22") or datetimes ("2026-10-22T14:00") interpreted in the
 * configured timezone (SDP_TIMEZONE, default UTC), and return readable values.
 */

function tzOffsetMs(utcMs: number, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = Object.fromEntries(dtf.formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Convert wall-clock time in `timeZone` to epoch ms. */
function wallToEpoch(y: number, mo: number, d: number, h: number, mi: number, s: number, ms: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  let epoch = guess - tzOffsetMs(guess, timeZone);
  // second pass handles DST transitions
  epoch = guess - tzOffsetMs(epoch, timeZone);
  return epoch;
}

/**
 * @param edge "start" → 00:00:00.000, "end" → 23:59:59.999 when only a date is given
 */
export function toEpochMs(input: string, timeZone: string, edge: "start" | "end" = "start"): string {
  const s = input.trim();
  if (/^\d{12,14}$/.test(s)) return s; // already epoch ms
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) throw new Error(`Invalid date "${input}". Use YYYY-MM-DD or YYYY-MM-DDTHH:mm.`);
  const [, y, mo, d, h, mi, sec] = m;
  if (h === undefined) {
    return String(
      edge === "start"
        ? wallToEpoch(+y, +mo, +d, 0, 0, 0, 0, timeZone)
        : wallToEpoch(+y, +mo, +d, 23, 59, 59, 999, timeZone),
    );
  }
  return String(wallToEpoch(+y, +mo, +d, +h, +mi, sec ? +sec : 0, 0, timeZone));
}

export function fromEpochMs(v: unknown, timeZone: string): string | null {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return null;
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(n))
    .replace(" ", "T");
}
