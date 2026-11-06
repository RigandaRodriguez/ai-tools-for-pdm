import { DatabaseSync } from 'node:sqlite';

const slotTimes = ['09:00', '11:00', '13:00', '15:00', '17:00'];

export function openDatabase(path = new URL('./boris.sqlite', import.meta.url)) {
  const database = new DatabaseSync(path, { timeout: 5000 });
  database.exec(`
    CREATE TABLE IF NOT EXISTS walk_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      walk_date TEXT NOT NULL,
      slot_time TEXT NOT NULL,
      booked_by TEXT,
      booked_at TEXT,
      UNIQUE (walk_date, slot_time),
      CHECK (
        (booked_by IS NULL AND booked_at IS NULL)
        OR
        (booked_by IS NOT NULL AND booked_at IS NOT NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS feedings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_name TEXT NOT NULL,
      fed_at TEXT NOT NULL
    );
  `);
  return database;
}

export function getTodaySlots(database, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  const insert = database.prepare(`
    INSERT INTO walk_slots (walk_date, slot_time) VALUES (?, ?)
    ON CONFLICT (walk_date, slot_time) DO NOTHING
  `);

  for (const time of slotTimes) insert.run(date, time);

  const slots = database.prepare(`
    SELECT id, slot_time, booked_by, booked_at
    FROM walk_slots WHERE walk_date = ? ORDER BY slot_time
  `).all(date);

  return {
    date,
    dateLabel: new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow', day: 'numeric', month: 'long', year: 'numeric',
    }).format(now),
    slots,
  };
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/gu, ' ') : '';
}

export function bookSlot(database, { slotId, walkDate, employeeName }) {
  const name = normalizeName(employeeName);
  if (!name) return { status: 400, message: 'Введите ФИО: имя не должно состоять только из пробелов.' };

  const id = Number(slotId);
  if (!/^\d+$/.test(slotId ?? '') || !Number.isSafeInteger(id) || id < 1) {
    return { status: 400, message: 'Некорректный слот. Обновите страницу и выберите прогулку.' };
  }

  const now = new Date();
  const { date } = getTodaySlots(database, now);
  if (walkDate !== date) {
    return { status: 409, message: 'Дата изменилась. Выберите свободный слот на сегодня.' };
  }

  const result = database.prepare(`
    UPDATE walk_slots SET booked_by = ?, booked_at = ?
    WHERE id = ? AND walk_date = ? AND booked_by IS NULL
  `).run(name, now.toISOString(), id, date);

  if (result.changes === 1) return { status: 303, slotId: id };

  const existing = database.prepare('SELECT id FROM walk_slots WHERE id = ? AND walk_date = ?').get(id, date);
  return existing
    ? { status: 409, message: 'Этот слот уже занят. Запись другого сотрудника сохранена. Выберите свободный слот.' }
    : { status: 404, message: 'Слот не найден. Выберите прогулку из списка.' };
}

export function getLastFeeding(database) {
  return database.prepare('SELECT id, employee_name, fed_at FROM feedings ORDER BY id DESC LIMIT 1').get();
}

export function recordFeeding(database, employeeName) {
  const name = normalizeName(employeeName);
  if (!name) return { status: 400, message: 'Введите ФИО: имя не должно состоять только из пробелов.' };

  const result = database.prepare('INSERT INTO feedings (employee_name, fed_at) VALUES (?, ?)')
    .run(name, new Date().toISOString());
  return { status: 303, feedingId: result.lastInsertRowid };
}
