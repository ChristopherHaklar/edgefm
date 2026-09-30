// Clock wheel scheduling, shared by the pipeline and the scheduler tool.

export const SCHEDULE_DAYS = 30; // pre-compute this many days of schedule (then loop)
export const EPOCH = new Date("2026-01-01T00:00:00Z"); // station start time — don't change once live

// --- Seeded PRNG (mulberry32) ---
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function seededPick(items, seed) {
  const rng = mulberry32(seed);
  // Weighted selection
  const totalWeight = items.reduce((s, i) => s + (i.weight ?? 1), 0);
  let r = rng() * totalWeight;
  for (const item of items) {
    r -= item.weight ?? 1;
    if (r <= 0) return item;
  }
  return items[items.length - 1];
}

// "9" → hour 9 only; "6-17" → 6 through 17; "22-2" wraps past midnight
function parseHours(hours) {
  const [from, to = from] = String(hours).split("-").map(Number);
  const valid = h => Number.isInteger(h) && h >= 0 && h <= 23;
  return valid(from) && valid(to) ? { from, to } : null;
}

function hoursInclude({ from, to }, hour) {
  return from <= to ? hour >= from && hour <= to : hour >= from || hour <= to;
}

// Which wheel name plays at each UTC hour (first matching schedule entry wins)
export function wheelForHour(wheels, hour) {
  const match = wheels.schedule.find(s => {
    const range = parseHours(s.hours);
    return range && hoursInclude(range, hour);
  });
  return match?.wheel ?? "default";
}

export function getPool(catalog, slotDef) {
  return catalog.tracks.filter(t => {
    if (t.category !== slotDef.type) return false;
    if (slotDef.tags) return slotDef.tags.every(tag => t.tags.includes(tag));
    return true;
  });
}

// Returns { errors, warnings }. Errors make the schedule unbuildable.
export function validateWheels(wheels, catalog) {
  const errors = [], warnings = [];
  if (!wheels?.wheels || typeof wheels.wheels !== "object") errors.push(`"wheels" must be an object of named wheels`);
  if (!Array.isArray(wheels?.schedule)) errors.push(`"schedule" must be an array`);
  if (errors.length) return { errors, warnings };

  for (const [name, slots] of Object.entries(wheels.wheels)) {
    if (!Array.isArray(slots) || slots.length === 0) { errors.push(`wheel "${name}" has no slots`); continue; }
    slots.forEach((slot, i) => {
      if (!slot?.type) errors.push(`wheel "${name}" slot ${i + 1} has no type`);
      else if (catalog && getPool(catalog, slot).length === 0) {
        warnings.push(`wheel "${name}" slot ${i + 1} (${slot.type}${slot.tags?.length ? ` [${slot.tags}]` : ""}) has no matching tracks and will be skipped`);
      }
    });
    if (catalog && slots.length && slots.every(s => s?.type && getPool(catalog, s).length === 0)) {
      errors.push(`wheel "${name}" has no slot with any matching tracks`);
    }
  }

  for (const entry of wheels.schedule) {
    if (!parseHours(entry.hours)) errors.push(`schedule hours "${entry.hours}" should look like "9", "6-17" or "22-2"`);
    if (!wheels.wheels[entry.wheel]) errors.push(`schedule refers to unknown wheel "${entry.wheel}"`);
  }

  for (let hour = 0; hour < 24; hour++) {
    if (!wheels.wheels[wheelForHour(wheels, hour)]) {
      errors.push(`hour ${hour} has no wheel assigned and there is no "default" wheel to fall back to`);
      break;
    }
  }

  return { errors, warnings };
}

export function buildSchedule(catalog, wheels, { onWarn = msg => console.warn(`  warning: ${msg}`) } = {}) {
  const { errors, warnings } = validateWheels(wheels, catalog);
  if (errors.length) throw new Error(`invalid wheels.json:\n  ${errors.join("\n  ")}`);
  warnings.forEach(onWarn);

  const targetSeconds = SCHEDULE_DAYS * 24 * 60 * 60;
  const schedule = []; // [{t, id}]

  let cursor = 0;
  let slotIndex = 0;

  while (cursor < targetSeconds) {
    const wheel = wheels.wheels[wheelForHour(wheels, Math.floor(cursor / 3600) % 24)];
    const pool = getPool(catalog, wheel[slotIndex % wheel.length]);

    // Empty slots are skipped; validation guarantees every wheel has a playable slot
    if (pool.length > 0) {
      const track = seededPick(pool, slotIndex);
      schedule.push({ t: cursor, id: track.id });
      cursor += track.duration;
    }
    slotIndex++;
  }

  // Loop at exactly SCHEDULE_DAYS (cutting the last track short) so hour-based
  // wheels stay aligned to the time of day on every loop
  return { epoch: EPOCH.toISOString(), totalSeconds: targetSeconds, entries: schedule };
}

// Same layout as the hand-written file: one slot / schedule entry per line
export function formatWheels(wheels) {
  const { wheels: named, schedule, ...rest } = wheels;
  if (Object.keys(rest).length) return JSON.stringify(wheels, null, 2) + "\n";

  const value = v => Array.isArray(v) ? `[${v.map(x => JSON.stringify(x)).join(", ")}]` : JSON.stringify(v);
  const inline = obj => `{ ${Object.entries(obj).map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`).join(", ")} }`;
  const list = (items, indent) =>
    `[\n${items.map(item => `${indent}  ${inline(item)}`).join(",\n")}\n${indent}]`;

  const wheelLines = Object.entries(named).map(([name, slots]) => `    ${JSON.stringify(name)}: ${list(slots, "    ")}`);
  return `{\n  "wheels": {\n${wheelLines.join(",\n")}\n  },\n  "schedule": ${list(schedule, "  ")}\n}\n`;
}
