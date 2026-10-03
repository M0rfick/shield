#!/usr/bin/env python3
"""Telegram schedule bot. Uses only the Python standard library."""
import argparse
import datetime as dt
import getpass
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.request
from schedule import GROUP, ScheduleClient, ScheduleError, parse_date, today, date_label
from attendance import AttendanceClient, AttendanceFlow

ROOT = Path(__file__).resolve().parent
KEYBOARD = {'keyboard': [[{'text': 'Сегодня'}, {'text': 'Завтра'}],
                         [{'text': 'Выбрать дату'}, {'text': 'Выбрать подгруппу'}],
                         [{'text': 'Отметить пропуск'}, {'text': 'Убрать отметку'}],
                         [{'text': 'Обновить'}]],
            'resize_keyboard': True}
SUBGROUPS = {'keyboard': [[{'text': 'Вся группа'}],
                         [{'text': 'Подгруппа 1'}, {'text': 'Подгруппа 2'}],
                         [{'text': 'Назад'}]], 'resize_keyboard': True}
HELP = ('Привет! Показываю расписание группы ' + GROUP + '.\n\n'
        'Выбери день кнопками или отправь дату, например 05.10.2026.\n'
        'Можно выбрать одну подгруппу или всю группу.\n\n'
        'Пропуски: дата → предмет и пара → студент из списка → причина → подтверждение.\n\n'
        'На одной паре можно нажать «Выбрать нескольких», отметить фамилии и указать общую причину.\n\n'
        'Удаление: «Убрать отметку» → дата → пара → студент → подтверждение удаления.\n\n'
        '/today — сегодня\n/tomorrow — завтра\n/date — выбрать дату\n'
        '/date 05.10.2026 — выбранная дата\n/miss — отметить пропуск\n/clear — убрать отметку\n/cancel — отмена\n'
        '/subgroup — выбрать подгруппу\n/refresh — перечитать сайт\n\n'
        'Расписание обновляется при запросе, с кешем до двух минут. '
        'Кнопка «Обновить» сразу перечитывает сайт.')


class TelegramError(Exception):
    def __init__(self, code=0, retry_after=0):
        self.code, self.retry_after = code, retry_after
        super().__init__(f'Ошибка Telegram ({code})')


class Telegram:
    def __init__(self, token):
        self.base = 'https://api.telegram.org/bot' + token + '/'

    def call(self, method, **payload):
        request = urllib.request.Request(self.base + method,
                    data=json.dumps(payload).encode('utf-8'),
                    headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                result = json.load(response)
        except urllib.error.HTTPError as exc:
            try:
                body = json.loads(exc.read())
                retry = body.get('parameters', {}).get('retry_after', 0)
            except (ValueError, OSError):
                retry = 0
            # Never print the exception URL, which contains the secret token.
            raise TelegramError(exc.code, retry) from None
        except (urllib.error.URLError, TimeoutError, OSError, ValueError):
            raise TelegramError() from None
        if not result.get('ok'):
            raise TelegramError(result.get('error_code', 0),
                                result.get('parameters', {}).get('retry_after', 0))
        return result['result']

    def send(self, chat_id, text, keyboard=KEYBOARD):
        # Leave room for UTF-16 length counting of Telegram emoji.
        for chunk in chunks(text):
            for attempt in range(3):
                try:
                    self.call('sendMessage', chat_id=chat_id, text=chunk,
                              reply_markup=keyboard, link_preview_options={'is_disabled': True})
                    break
                except TelegramError as exc:
                    if attempt == 2 or (exc.code and exc.code not in (429, 500, 502, 503, 504)):
                        raise
                    time.sleep(min(max(exc.retry_after, 2 ** attempt), 60))


def chunks(text, limit=3000):
    while len(text) > limit:
        cut = text.rfind('\n', 0, limit + 1)
        if cut < 1:
            cut = limit
        yield text[:cut]
        text = text[cut:].lstrip('\n')
    if text:
        yield text


class Bot:
    def __init__(self, telegram, schedule, state=None, attendance=None):
        self.telegram, self.schedule = telegram, schedule
        self.state = state or {'offset': 0, 'subgroups': {}}
        self.state.setdefault('subgroups', {})
        self.state.setdefault('identities', {})
        self.attendance = attendance

    def handle(self, message):
        text = (message.get('text') or '').strip()
        if not text or not message.get('chat'):
            return
        chat = message['chat']['id']
        sender = str(message.get('from', {}).get('id', chat))
        subgroup = self.state['subgroups'].get(sender, 0)
        command, _, argument = text.partition(' ')
        command = command.split('@')[0].lower()
        normalized = text.lower()
        send = lambda value, keyboard=KEYBOARD: self.telegram.send(chat, value, keyboard)
        if self.attendance and self.attendance.handle(message, send, KEYBOARD):
            return
        if command in ('/start', '/help'):
            send(HELP)
            return
        if normalized == 'выбрать подгруппу' or command == '/subgroup':
            send('Какое расписание показывать?', SUBGROUPS)
            return
        choices = {'вся группа': 0, 'подгруппа 1': 1, 'подгруппа 2': 2}
        if normalized in choices:
            subgroup = choices[normalized]
            self.state['subgroups'][sender] = subgroup
            send('Выбрана вся группа.' if not subgroup else f'Выбрана подгруппа {subgroup}.')
            return
        if normalized == 'назад':
            send('Выбери день или отправь дату.')
            return
        try:
            day = today()
            if text.lower() == 'выбрать дату' or (command == '/date' and not argument):
                dates = [date_label(day + dt.timedelta(days=i)) for i in range(14)]
                keyboard = {'keyboard': [[{'text': x} for x in dates[i:i+2]] for i in range(0, len(dates), 2)], 'resize_keyboard': True}
                send('Выбери дату или отправь любую дату в формате ДД.ММ.ГГГГ.', keyboard)
                return
            if command == '/date':
                day = parse_date(argument)
            elif command in ('/tomorrow',) or normalized == 'завтра':
                day += dt.timedelta(days=1)
            elif command == '/refresh' or normalized == 'обновить':
                self.schedule.clear()
            elif command == '/today' or normalized == 'сегодня':
                pass
            else:
                try:
                    day = parse_date(text)
                except ValueError:
                    send('Выбери кнопку или отправь дату в формате ДД.ММ.ГГГГ. Справка: /help')
                    return
            send(self.schedule.render_day(day, subgroup))
        except (ScheduleError, ValueError) as exc:
            send(str(exc))


def load_state(path):
    try:
        state = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(state.get('offset'), int) or not isinstance(state.get('subgroups'), dict):
            raise ValueError('state')
        return state
    except (OSError, ValueError, TypeError, AttributeError):
        return {'offset': 0, 'subgroups': {}}


def save_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state), encoding='utf-8')
    temporary.chmod(0o600)
    temporary.replace(path)


def run():
    parser = argparse.ArgumentParser(description='Бот расписания группы ' + GROUP)
    parser.add_argument('--preview', metavar='ДД.ММ.ГГГГ', help='проверить сайт без Telegram')
    parser.add_argument('--subgroup', type=int, choices=(0, 1, 2), default=0)
    args = parser.parse_args()
    schedule = ScheduleClient()
    if args.preview:
        try:
            print(schedule.render_day(parse_date(args.preview), args.subgroup))
        except (ScheduleError, ValueError) as exc:
            print(str(exc), file=sys.stderr)
            return 1
        return 0
    config_path = ROOT / '.env'
    if config_path.exists():
        allowed = {'TELEGRAM_BOT_TOKEN','SHEETS_WEB_APP_URL','SHEETS_SHARED_SECRET',
                   'AUTHORIZED_USER_IDS','AUTHORIZED_USERNAMES','BOT_STOP_FILE','BOT_STATE_PATH'}
        for line in config_path.read_text(encoding='utf-8').splitlines():
            key, separator, value = line.partition('=')
            if separator and key.strip() in allowed:
                os.environ.setdefault(key.strip(), value.strip().strip('"'))
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '').strip()
    if not token:
        if not sys.stdin.isatty():
            print('В настройках сервера нужно заполнить TELEGRAM_BOT_TOKEN и перезапустить сервис.')
            return 1
        token = getpass.getpass('Вставь токен из BotFather (ввод скрыт) и нажми Enter: ').strip()
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]+', token):
        print('Токен не похож на токен Telegram. Получи его у @BotFather.')
        return 1
    telegram = Telegram(token)
    try:
        identity = telegram.call('getMe')
        webhook = telegram.call('getWebhookInfo')
        if webhook.get('url'):
            print('У этого бота настроен другой способ подключения (webhook). '
                  'Создай нового бота для этой версии или отключи старое подключение.')
            return 1
    except TelegramError as exc:
        print('Проверь токен из BotFather.' if exc.code in (401, 404) else
              'Не удалось подключиться к Telegram. Проверь интернет и повтори запуск.')
        return 1
    state_path = Path(os.environ.get('BOT_STATE_PATH') or str(ROOT / 'state.json')).expanduser()
    try:
        state_path.parent.mkdir(parents=True, exist_ok=True)
    except OSError:
        print('Не удалось открыть папку состояния бота. Проверь BOT_STATE_PATH и подключённый диск сервера.')
        return 1
    state = load_state(state_path)
    state.setdefault('identities', {})
    attendance = AttendanceFlow(AttendanceClient(os.environ.get('SHEETS_WEB_APP_URL', ''),
                                                 os.environ.get('SHEETS_SHARED_SECRET', '')),
        schedule, os.environ.get('AUTHORIZED_USER_IDS', '').split(','),
        os.environ.get('AUTHORIZED_USERNAMES', 'Ivan_Morfick,zxcWenty,Shcherbakov_23').split(','), state['identities'])
    bot = Bot(telegram, schedule, state, attendance)
    print(f"Бот @{identity.get('username', '')} запущен. Открой его в Telegram и нажми Start.")
    print('Это окно должно оставаться открытым. Для остановки нажми Ctrl+C.')
    connected = False
    while True:
        stop_file = os.environ.get('BOT_STOP_FILE')
        if stop_file and Path(stop_file).exists():
            print('Бот остановлен для обновления.')
            return 0
        try:
            updates = telegram.call('getUpdates', offset=bot.state['offset'], timeout=30,
                                    allowed_updates=['message'])
            if not connected:
                print('Получение сообщений Telegram работает.')
                connected = True
            for update in updates:
                try:
                    bot.handle(update.get('message', {}))
                except TelegramError as exc:
                    if exc.code not in (400, 403):
                        raise
                    print('Не удалось отправить ответ в один из чатов.')
                bot.state['offset'] = update['update_id'] + 1
                save_state(state_path, bot.state)
        except TelegramError as exc:
            if exc.code in (401, 404, 409):
                print('Токен недействителен.' if exc.code != 409 else
                      'Этот бот уже запущен в другом месте. Останови другую копию.')
                return 1
            print('Связь с Telegram прервалась. Повторяю подключение…')
            time.sleep(min(max(exc.retry_after, 5), 60))
        except OSError:
            print('Не удалось сохранить настройки. Проверь, что папка доступна для записи.')
            return 1


if __name__ == '__main__':
    try:
        sys.exit(run())
    except KeyboardInterrupt:
        print('\nБот остановлен.')
