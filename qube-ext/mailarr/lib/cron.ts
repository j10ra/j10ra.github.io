export function cronMatches(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);

  if (fields.length !== 5) throw new Error("Cron must have five fields");

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minuteMatch = fieldMatches(minute, date.getMinutes(), 0, 59);
  const hourMatch = fieldMatches(hour, date.getHours(), 0, 23);
  const monthMatch = fieldMatches(month, date.getMonth() + 1, 1, 12);
  const domMatch = fieldMatches(dayOfMonth, date.getDate(), 1, 31);
  const dowMatch = fieldMatches(dayOfWeek, date.getDay(), 0, 7, true);
  const dayMatch =
    dayOfMonth === "*" || dayOfWeek === "*"
      ? domMatch && dowMatch
      : domMatch || dowMatch;

  return minuteMatch && hourMatch && monthMatch && dayMatch;
}

export function localMinuteKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");

  return [
    date.getFullYear(),
    "-",
    pad(date.getMonth() + 1),
    "-",
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    ":",
    pad(date.getMinutes()),
  ].join("");
}

function fieldMatches(
  field: string,
  value: number,
  minimum: number,
  maximum: number,
  sundayAlias = false,
): boolean {
  return field.split(",").some((part) => {
    const [rangePart, stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);

    if (!Number.isInteger(step) || step <= 0) throw new Error(`Invalid cron step: ${part}`);

    const [start, end] =
      rangePart === "*"
        ? [minimum, maximum]
        : rangePart.includes("-")
          ? rangePart.split("-").map(Number)
          : [Number(rangePart), Number(rangePart)];

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < minimum ||
      end > maximum ||
      start > end
    ) {
      throw new Error(`Invalid cron field: ${field}`);
    }

    const normalized = sundayAlias && value === 0 && start === 7 ? 7 : value;

    return normalized >= start && normalized <= end && (normalized - start) % step === 0;
  });
}
