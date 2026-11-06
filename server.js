import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { openDatabase, getTodaySlots, bookSlot, getLastFeeding, recordFeeding } from './database.js';

const host = '127.0.0.1';
const port = 3000;
const template = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const database = openDatabase();
getTodaySlots(database);

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${host}:${port}`);
  const pathname = url.pathname;

  if (!['/', '/book', '/feed'].includes(pathname)) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Страница не найдена');
    return;
  }

  const allowedMethods = pathname === '/' ? ['GET', 'HEAD'] : ['POST'];
  if (!allowedMethods.includes(request.method)) {
    response.writeHead(405, {
      'Content-Type': 'text/plain; charset=utf-8',
      Allow: allowedMethods.join(', '),
    });
    response.end('Метод не поддерживается');
    return;
  }

  try {
    let status = 200;
    let message = '';
    if (pathname === '/book' || pathname === '/feed') {
      const contentType = request.headers['content-type']?.split(';')[0].trim();
      if (contentType !== 'application/x-www-form-urlencoded') {
        status = 415;
        message = 'Отправьте запись через форму на странице.';
      } else {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > 16 * 1024) {
            response.writeHead(413, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Слишком большой запрос. Сократите введённое ФИО.');
            return;
          }
          chunks.push(chunk);
        }
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        const result = pathname === '/feed'
          ? recordFeeding(database, form.get('employee_name'))
          : bookSlot(database, {
          slotId: form.get('slot_id'),
          walkDate: form.get('walk_date'),
          employeeName: form.get('employee_name'),
        });
        if (result.status === 303) {
          const location = pathname === '/feed' ? `/?fed=${result.feedingId}#feeding` : `/?booked=${result.slotId}`;
          response.writeHead(303, { Location: location, 'Cache-Control': 'no-store' });
          response.end();
          return;
        }
        status = result.status;
        message = result.message;
      }
    }
    const { date, dateLabel, slots } = getTodaySlots(database);
    const feeding = getLastFeeding(database);
    let feedingMessage = pathname === '/feed' ? message : '';
    if (pathname === '/feed') message = '';
    if (pathname === '/' && feeding && url.searchParams.get('fed') === String(feeding.id)) {
      feedingMessage = 'Кормление отмечено.';
    }
    const feedingMarkup = feeding
      ? `<p class="feeding-name">${escapeHtml(feeding.employee_name)}</p>
         <p><time datetime="${escapeHtml(feeding.fed_at)}">${escapeHtml(new Intl.DateTimeFormat('ru-RU', {
           timeZone: 'Europe/Moscow', dateStyle: 'long', timeStyle: 'medium',
         }).format(new Date(feeding.fed_at)))}</time> · Москва</p>`
      : '<p>Кормлений пока не отмечали.</p>';
    const confirmed = slots.find((slot) => String(slot.id) === url.searchParams.get('booked') && slot.booked_by !== null);
    if (pathname === '/' && confirmed) {
      message = `Запись подтверждена: ${confirmed.slot_time} — ${confirmed.booked_by}.`;
    }
    const slotMarkup = slots.map((slot) => {
      const booked = slot.booked_by !== null;
      return `<li class="slot ${booked ? 'slot--booked' : 'slot--free'}">
        <span class="slot-time">${escapeHtml(slot.slot_time)}</span>
        <span class="slot-status">${booked ? 'Занят' : 'Свободен'}</span>
        ${booked ? `<span class="employee">${escapeHtml(slot.booked_by)}</span>` : `
          <form class="booking-form" action="/book" method="post">
            <input type="hidden" name="slot_id" value="${slot.id}">
            <input type="hidden" name="walk_date" value="${date}">
            <label for="name-${slot.id}">ФИО для прогулки в ${escapeHtml(slot.slot_time)}</label>
            <input id="name-${slot.id}" name="employee_name" type="text" required placeholder="Анна Тестова" autocomplete="off">
            <button type="submit">Записаться на ${escapeHtml(slot.slot_time)}</button>
          </form>`}
      </li>`;
    }).join('\n');
    const notice = message ? `<p class="feedback ${status >= 400 ? 'feedback--error' : ''}" role="${status >= 400 ? 'alert' : 'status'}">${escapeHtml(message)}</p>` : '';
    const feedingNotice = feedingMessage ? `<p class="feedback ${status >= 400 ? 'feedback--error' : ''}" role="${status >= 400 ? 'alert' : 'status'}">${escapeHtml(feedingMessage)}</p>` : '';
    const replacements = { DATE: date, DATE_LABEL: dateLabel, SLOTS: slotMarkup, MESSAGE: notice, FEEDING: feedingMarkup, FEEDING_MESSAGE: feedingNotice };
    const page = template.replace(/\{\{(DATE|DATE_LABEL|SLOTS|MESSAGE|FEEDING|FEEDING_MESSAGE)\}\}/g,
      (_, key) => replacements[key]);

    response.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(request.method === 'HEAD' ? undefined : page);
  } catch (error) {
    console.error('Не удалось обработать запрос:', error);
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Не удалось обработать запрос. Попробуйте обновить страницу.');
  }
});

server.on('close', () => database.close());

server.on('error', (error) => {
  database.close();
  console.error(
    error.code === 'EADDRINUSE'
      ? `Порт ${port} занят. Остановите предыдущий запуск приложения и повторите npm start.`
      : `Не удалось запустить сервер: ${error.message}`,
  );
  process.exitCode = 1;
});

server.listen(port, host, () => {
  console.log(`Кто выгуливает Бориса: http://${host}:${port}`);
  console.log('Для остановки нажмите Ctrl+C.');
});
