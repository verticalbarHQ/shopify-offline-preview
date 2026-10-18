import { Drop } from "liquidjs";

interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  /** Minutes east of UTC. */
  offset: number;
}
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function parts(instant: number, timeZone: string): Parts {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
      hourCycle: "h23",
    })
      .formatToParts(new Date(instant))
      .map((part) => [part.type, part.value]),
  );
  const number = (key: string) => Number(values[key]);
  const wall = Date.UTC(
    number("year"),
    number("month") - 1,
    number("day"),
    number("hour"),
    number("minute"),
    number("second"),
  );
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
    second: number("second"),
    weekday: weekdays.indexOf(String(values.weekday)),
    offset: Math.round((wall - Math.floor(instant / 1000) * 1000) / 60000),
  };
}
const pad = (value: number, width = 2) => String(value).padStart(width, "0");
function offsetText(minutes: number, separator: string): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}${separator}${pad(absolute % 60)}`;
}

/**
 * A snapshot timestamp as Shopify's Liquid shows it, in the shop's timezone (measured on a
 * development store): output is Ruby's Time#to_s (`2026-10-17 07:10:31 -0400`), JSON inside an
 * object is ISO 8601 with the offset, and the `json` filter on the value itself prints Time#to_a.
 */
const utcZones = new Set(["UTC", "Etc/UTC", "Etc/Universal", "Universal", "Etc/Zulu", "Zulu"]);

export class ShopTime extends Drop {
  readonly #instant: number;
  readonly #timeZone: string;
  constructor(iso: string, timeZone: string) {
    super();
    this.#instant = Date.parse(iso);
    this.#timeZone = timeZone;
  }
  #parts(): Parts {
    return parts(this.#instant, this.#timeZone);
  }
  valueOf(): string {
    const p = this.#parts();
    // Ruby writes a time in the UTC zone with "UTC" instead of an offset.
    const zone = utcZones.has(this.#timeZone) ? "UTC" : offsetText(p.offset, "");
    return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ${zone}`;
  }
  override toString(): string {
    return this.valueOf();
  }
  toJSON(): string {
    const p = this.#parts();
    const zone = utcZones.has(this.#timeZone) ? "Z" : offsetText(p.offset, ":");
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${zone}`;
  }
  /** Ruby's Time#to_a: sec, min, hour, day, month, year, wday, yday, isdst, zone. */
  rubyArray(): unknown[] {
    const p = this.#parts();
    const yday = (Date.UTC(p.year, p.month - 1, p.day) - Date.UTC(p.year, 0, 1)) / 86_400_000 + 1;
    const january = parts(Date.UTC(p.year, 0, 1), this.#timeZone).offset;
    const july = parts(Date.UTC(p.year, 6, 1), this.#timeZone).offset;
    const zone =
      new Intl.DateTimeFormat("en-US", { timeZone: this.#timeZone, timeZoneName: "short" })
        .formatToParts(new Date(this.#instant))
        .find((part) => part.type === "timeZoneName")?.value ?? "";
    return [
      p.second,
      p.minute,
      p.hour,
      p.day,
      p.month,
      p.year,
      p.weekday,
      yday,
      january !== july && p.offset === Math.max(january, july),
      zone,
    ];
  }
}

/** The timestamp as a ShopTime, or null when the snapshot has none. */
export function shopTime(iso: string | null | undefined, timeZone: string): ShopTime | null {
  return iso ? new ShopTime(iso, timeZone) : null;
}
