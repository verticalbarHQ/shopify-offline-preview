interface MemoryLimit {
  use(amount: number): void;
}
const day = 86_400_000;
function utcDate(year: number, month: number, date: number) {
  const result = new Date(0);
  result.setUTCFullYear(year, month, date);
  return result;
}
/** Formats a shop-local clock with UTC arithmetic, independent of the host's DST rules. */
export function formatDate(
  date: Date,
  zone: string,
  locale: string,
  pattern: string,
  memory: MemoryLimit,
): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, Number(part.value)]),
  );
  const year = parts.year ?? 0,
    month = (parts.month ?? 1) - 1,
    dateOfMonth = parts.day ?? 1;
  const hour = parts.hour ?? 0,
    minute = parts.minute ?? 0,
    second = parts.second ?? 0;
  const wall = utcDate(year, month, dateOfMonth);
  const weekday = wall.getUTCDay(),
    yearStart = utcDate(year, 0, 1).valueOf();
  const ordinal = Math.floor((wall.valueOf() - yearStart) / day) + 1;
  const thursday = new Date(wall);
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (weekday || 7));
  const isoYear = thursday.getUTCFullYear();
  const isoWeek = Math.ceil(
    ((thursday.valueOf() - utcDate(isoYear, 0, 1).valueOf()) / day + 1) / 7,
  );
  wall.setUTCHours(hour, minute, second, date.getUTCMilliseconds());
  const offset = Math.round((wall.valueOf() - date.valueOf()) / 1000);
  const absolute = Math.abs(offset),
    sign = offset < 0 ? "-" : "+";
  const offsetHour = String(Math.floor(absolute / 3600)).padStart(2, "0");
  const offsetMinute = String(Math.floor(absolute / 60) % 60).padStart(2, "0");
  const offsetSecond = String(absolute % 60).padStart(2, "0");
  const localized = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: zone }).format(date);
  const zoneName =
    new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "short" })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value ?? zone;
  const values: Record<string, string | number> = {
    a: localized({ weekday: "short" }),
    A: localized({ weekday: "long" }),
    b: localized({ month: "short" }),
    B: localized({ month: "long" }),
    h: localized({ month: "short" }),
    C: Math.floor(year / 100),
    d: dateOfMonth,
    e: dateOfMonth,
    H: hour,
    k: hour,
    I: hour % 12 || 12,
    l: hour % 12 || 12,
    j: ordinal,
    m: month + 1,
    M: minute,
    S: second,
    L: date.getUTCMilliseconds(),
    p: hour < 12 ? "AM" : "PM",
    P: hour < 12 ? "am" : "pm",
    s: Math.floor(date.valueOf() / 1000),
    u: weekday || 7,
    w: weekday,
    U: Math.floor((ordinal - 1 - weekday + 7) / 7),
    W: Math.floor((ordinal - 1 - ((weekday + 6) % 7) + 7) / 7),
    V: isoWeek,
    G: isoYear,
    g: ((isoYear % 100) + 100) % 100,
    y: ((year % 100) + 100) % 100,
    Y: year,
    Z: zoneName,
    "%": "%",
    n: "\n",
    t: "\t",
  };
  const aliases: Record<string, string> = {
    c: "%a %b %e %H:%M:%S %Y",
    D: "%m/%d/%y",
    x: "%m/%d/%y",
    F: "%Y-%m-%d",
    R: "%H:%M",
    T: "%H:%M:%S",
    X: "%H:%M:%S",
    r: "%I:%M:%S %p",
    v: "%e-%^b-%Y",
  };
  const widths: Record<string, number> = {
    C: 2,
    d: 2,
    e: 2,
    H: 2,
    k: 2,
    I: 2,
    l: 2,
    j: 3,
    m: 2,
    M: 2,
    S: 2,
    U: 2,
    W: 2,
    V: 2,
    g: 2,
    y: 2,
    Y: 4,
    L: 3,
  };
  function render(format: string): string {
    return format.replace(
      /%([-_0^#:]*)(\d*)([EO]?)([%a-zA-Z])/g,
      (raw: string, flags: string, digits: string, _modifier: string, code: string) => {
        let value: string;
        if (code === "N") {
          const precision = Number(digits) || 9;
          memory.use(precision);
          value = String(date.getUTCMilliseconds())
            .padStart(3, "0")
            .slice(0, precision)
            .padEnd(precision, "0");
        } else if (code === "z") {
          const colons = flags.split(":").length - 1;
          value = sign + offsetHour + (colons ? ":" : "") + offsetMinute;
          if (colons === 2) value += `:${offsetSecond}`;
          if (colons >= 3)
            value =
              sign +
              offsetHour +
              (absolute % 3600 ? `:${offsetMinute}${absolute % 60 ? `:${offsetSecond}` : ""}` : "");
        } else if (Object.hasOwn(aliases, code)) value = render(aliases[code] ?? "");
        else if (Object.hasOwn(values, code)) value = String(values[code]);
        else return raw;
        if (flags.includes("^")) value = value.toUpperCase();
        else if (flags.includes("#"))
          value =
            code === "p" || code === "P" || code === "Z"
              ? value.toLowerCase()
              : value.toUpperCase();
        const width = flags.includes("-") ? 0 : Number(digits) || widths[code] || 0;
        const padding = Math.max(0, width - value.length);
        memory.use(padding);
        const fill =
          flags.includes("_") || (!flags.includes("0") && "ekl".includes(code)) ? " " : "0";
        return fill === "0" && value.startsWith("-")
          ? `-${value.slice(1).padStart(width - 1, fill)}`
          : value.padStart(width, fill);
      },
    );
  }
  memory.use(pattern.length);
  return render(pattern);
}
