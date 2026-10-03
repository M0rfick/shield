"""Attendance endpoint and a confirmation-based Telegram flow."""
import datetime as dt
import json
import re
import urllib.error
import urllib.parse
import urllib.request
from schedule import ScheduleError, parse_date, today, date_label


class AttendanceError(Exception):
    pass


class AttendanceClient:
    def __init__(self, url='', secret=''):
        self.url, self.secret = url, secret
        if url and not re.fullmatch(r'https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec', url):
            raise AttendanceError('Нужна ссылка опубликованного приложения Google, заканчивающаяся на /exec.')

    @property
    def ready(self):
        return bool(self.url and self.secret)

    def call(self, action, **data):
        if not self.ready:
            raise AttendanceError('Запись в таблицу ещё не подключена. Администратору нужно подключить скрипт Google.')
        body = dict(data, action=action, secret=self.secret)
        request = urllib.request.Request(self.url, data=json.dumps(body).encode(),
            headers={'Content-Type': 'application/json'}, method='POST')
        try:
            with urllib.request.urlopen(request, timeout=40) as response:
                result = json.loads(response.read(100000))
        except (urllib.error.URLError, OSError, ValueError):
            raise AttendanceError('Нет подтверждения от таблицы. Попробуй ещё раз; бот проверит текущую отметку.') from None
        if not result.get('ok'):
            raise AttendanceError(result.get('error', 'Таблица отклонила запись.'))
        return result


def keyboard(labels):
    return {'keyboard': [[{'text': label}] for label in labels], 'resize_keyboard': True}


class AttendanceFlow:
    def __init__(self, client, schedule, allowed_ids=None, allowed_names=None, identities=None):
        self.client, self.schedule = client, schedule
        self.allowed_ids = set(str(x) for x in (allowed_ids or []))
        self.allowed_names = {str(x).lower().lstrip('@') for x in (allowed_names or [])}
        self.identities = identities if identities is not None else {}
        self.pending = {}

    def authorised(self, user):
        sender = str(user.get('id', ''))
        if sender in self.allowed_ids:
            return True
        username = user.get('username', '').lower()
        for allowed in self.allowed_names:
            if allowed in self.identities:
                if self.identities[allowed] == sender:
                    return True
            elif allowed == username:
                self.identities[allowed] = sender
                return True
        return False

    def handle(self, message, send, default_keyboard):
        text = (message.get('text') or '').strip()
        sender = str(message.get('from', {}).get('id', ''))
        chat = str(message.get('chat', {}).get('id', ''))
        key = (chat, sender)
        command, _, argument = text.partition(' ')
        command = command.split('@')[0].lower()
        lower = text.lower()
        permitted = self.authorised(message.get('from', {}))
        if command in ('/cancel', '/start') or lower == 'отмена':
            self.pending.pop(key, None)
            if command != '/start':
                send('Запись отменена.', default_keyboard)
                return True
            return False
        match = re.fullmatch(r'(.+?)\s*[—–-]\s*(не был|не была|пропуск|больничный|заявление|объяснительная)', text, re.I)
        if match and len(match.group(1).split()) < 2:
            match = None
        clear = command == '/clear' or lower == 'убрать отметку'
        new = clear or command == '/miss' or lower == 'отметить пропуск' or match is not None
        pending = self.pending.get(key)
        if not new and not pending:
            return False
        if not permitted:
            send('Запись доступна участникам из списка Telegram-имён. '
                 'Передай администратору своё имя вида @username.')
            return True
        if message.get('chat', {}).get('type') != 'private':
            send('Для записи отметок открой личный чат с ботом.')
            return True
        if not self.client.ready:
            send('Функция пропусков подготовлена, но Google Таблица ещё не подключена. '
                 'После подключения можно отправить «Фамилия Имя — не был».')
            return True
        try:
            if new:
                name = argument.strip() if command in ('/miss', '/clear') else match.group(1).strip() if match else ''
                pending = {'mode': 'clear' if clear else 'mark', 'stage': 'date', 'date': '', 'period': 0, 'name': name, 'mark': '', 'attested': False,
                           'username': message.get('from', {}).get('username', '').lower()}
                self.pending[key] = pending
                send('С какой даты убрать отметку?' if clear else 'На какую дату отметить пропуск?', keyboard(['Сегодня', 'Завтра', 'Вчера', 'Другая дата', 'Отмена']))
                return True
            stage = pending['stage']
            if stage == 'name':
                if len(text.split()) < 2:
                    send('Нужны фамилия и имя, например «Иванов Иван».')
                    return True
                pending['name'], pending['stage'] = text, 'date'
                send('На какую дату?', keyboard(['Сегодня', 'Завтра', 'Вчера', 'Другая дата', 'Отмена']))
            elif stage == 'date':
                if lower == 'другая дата':
                    days = [date_label(today() + dt.timedelta(days=i)) for i in range(-7, 7)]
                    picker = {'keyboard': [[{'text': x} for x in days[i:i+2]] for i in range(0, len(days), 2)]
                              + [[{'text': 'Отмена'}]], 'resize_keyboard': True}
                    send('Выбери дату или отправь её в формате ДД.ММ.ГГГГ.', picker)
                    return True
                offsets = {'сегодня': 0, 'завтра': 1, 'вчера': -1}
                day = today() + dt.timedelta(days=offsets[lower]) if lower in offsets else parse_date(text)
                choices = {}
                if pending['mode'] == 'clear':
                    result = self.client.call('pairs', username=pending['username'], date=day.isoformat())
                    for pair in result['pairs']:
                        label = f"{pair['period']} пара — {pair['subject'] or 'предмет не указан'}"
                        choices[label] = (pair['period'], pair['subject'], 0)
                else:
                    snapshot = self.schedule.snapshot_for(day)
                    lessons = [x for x in snapshot.lessons if x.date == day]
                    for lesson in sorted(lessons, key=lambda x:(x.period,x.subgroup,x.subject)):
                        label = f'{lesson.period} пара — {lesson.subject}'
                        if lesson.subgroup:
                            label += f' (подгр. {lesson.subgroup})'
                        choices[label] = (lesson.period, lesson.subject, lesson.subgroup)
                if not choices:
                    send('На эту дату занятий на сайте нет. Выбери другую дату.', keyboard(['Сегодня', 'Завтра', 'Вчера', 'Другая дата', 'Отмена']))
                    return True
                pending.update(date=day.isoformat(), choices=choices, stage='period')
                send(date_label(day) + '\nВыбери пару:', keyboard(list(choices) + ['Отмена']))
            elif stage == 'period':
                choice = pending['choices'].get(text)
                if not choice:
                    send('Выбери пару кнопкой.', keyboard(list(pending['choices']) + ['Отмена']))
                    return True
                pending.update(period=choice[0], subject=choice[1], subgroup=choice[2])
                if pending['name']:
                    if pending['mode'] == 'clear':
                        self.prepare_clear(pending, key, send, default_keyboard)
                    else:
                        pending['stage']='reason'
                        self.ask_reason(send)
                else:
                    result=self.client.call('roster',username=pending['username'],date=pending['date'])
                    names=result.get('names',[])
                    if not names or any(not isinstance(x,str) for x in names):
                        raise AttendanceError('Не удалось получить список студентов из таблицы.')
                    pending.update(stage='student',names=names,filtered=names,page=0)
                    self.show_students(pending,send)
            elif stage == 'student':
                if pending['mode'] == 'mark' and text in ('Выбрать нескольких', 'Выбирать по одному'):
                    pending.update(multi=text=='Выбрать нескольких', selected=[])
                    self.show_students(pending,send)
                elif pending.get('multi') and text == 'Выбрать причину':
                    if not pending.get('selected'):
                        send('Сначала выбери хотя бы одного студента.')
                    else:
                        pending['stage']='reason'
                        self.ask_reason(send,pending)
                elif pending.get('multi') and text == 'Сбросить выбор':
                    pending['selected']=[]
                    self.show_students(pending,send)
                elif text == 'Весь список':
                    pending.update(filtered=pending['names'],page=0)
                    self.show_students(pending,send)
                elif text in ('Далее →','← Назад'):
                    step=12 if text=='Далее →' else -12
                    pending['page']=max(0,min(pending['page']+step,((len(pending['filtered'])-1)//12)*12))
                    self.show_students(pending,send)
                elif text in pending.get('student_choices',{}):
                    if pending.get('multi'):
                        full=pending['student_choices'][text]
                        selected=pending['selected']
                        if full in selected:selected.remove(full)
                        else:selected.append(full)
                        self.show_students(pending,send)
                        return True
                    pending.update(name=pending['student_choices'][text],stage='reason')
                    if pending['mode'] == 'clear':
                        self.prepare_clear(pending, key, send, default_keyboard)
                    else:
                        self.ask_reason(send)
                else:
                    wanted=text.lower().replace('ё','е').lstrip('@')
                    filtered=[x for x in pending['names'] if wanted in x.lower().replace('ё','е')]
                    if not filtered:
                        send('Студент не найден. Выбери фамилию кнопкой или напиши часть фамилии.')
                    else:
                        pending.update(filtered=filtered,page=0)
                        self.show_students(pending,send)
            elif stage == 'reason':
                marks = {'Н — без уважительной причины': 'Н', 'Б — справка': 'Б',
                         'З — заявление': 'З', 'О — объяснительная': 'О'}
                mark = marks.get(text)
                if not mark:
                    send('Выбери основание кнопкой.')
                    return True
                pending['mark'] = mark
                if mark == 'Б':
                    pending['stage'] = 'evidence'
                    send(('Подтверди для каждого выбранного студента: справка проверена и есть в чате группы по шаблону. '
                          if pending.get('multi') else 'Подтверди: справка проверена и есть в чате группы по шаблону. ')+
                         'Бот не проверяет документы самостоятельно.',
                         keyboard(['Справка проверена и есть в чате', 'Отмена']))
                elif mark == 'З':
                    pending['stage'] = 'evidence'
                    send(('Подтверди для каждого выбранного студента: заявление есть в чате и на нём есть подпись Назарова. '
                          if pending.get('multi') else 'Подтверди: заявление есть в чате и на нём есть подпись Назарова. ')+
                         'Лимит — три разных дня за месяц.',
                         keyboard(['Заявление в чате, подпись есть', 'Отмена']))
                elif mark == 'О':
                    pending['stage'] = 'exception'
                    send('Объяснительная отмечается как «Н». «З» допускается только '
                         'в особом случае, согласованном с куратором.'+
                         (' Согласование требуется для каждого выбранного студента.' if pending.get('multi') else ''),
                         keyboard(['Записать Н', 'Куратор согласовал З', 'Отмена']))
                else:
                    self.prepare(pending, sender, send)
            elif stage == 'evidence':
                expected = 'Справка проверена и есть в чате' if pending['mark'] == 'Б' else 'Заявление в чате, подпись есть'
                if text != expected:
                    send('Для этого основания требуется подтверждение ответственным.', keyboard([expected, 'Отмена']))
                    return True
                pending['attested'] = True
                self.prepare(pending, sender, send)
            elif stage == 'exception':
                if text not in ('Записать Н', 'Куратор согласовал З'):
                    send('Выбери один из вариантов кнопкой.')
                    return True
                pending['mark'] = 'Н' if text == 'Записать Н' else 'З'
                pending['exception'] = text == 'Куратор согласовал З'
                pending['attested'] = pending['exception']
                self.prepare(pending, sender, send)
            elif stage == 'confirm':
                confirmation = 'Подтвердить удаление' if pending['mode'] == 'clear' else 'Подтвердить запись'
                if text != confirmation:
                    send(f'Нажми «{confirmation}» или «Отмена».', keyboard([confirmation, 'Отмена']))
                    return True
                if pending['mode'] == 'clear':
                    result = self.client.call('clear_commit', username=pending['username'], **pending['prepared'])
                    self.pending.pop(key, None)
                    send(f"Отметка удалена: {result['name']}\n{date_label(dt.date.fromisoformat(result['date']))}, {result['period']} пара\n"
                         f"Лист «{result['sheet']}», ячейка {result['cell']}", default_keyboard)
                    return True
                self.schedule.clear()
                fresh=self.schedule.snapshot_for(dt.date.fromisoformat(pending['date']))
                lessons=self.day_lessons(fresh,dt.date.fromisoformat(pending['date']))
                if lessons!=pending['prepared']['lessons']:
                    raise AttendanceError('Расписание изменилось после просмотра. Выбери дату и предмет заново.')
                action = 'batch_commit' if pending.get('multi') else 'commit'
                result = self.client.call(action, username=pending['username'], **pending['prepared'])
                self.pending.pop(key, None)
                if pending.get('multi'):
                    students='\n'.join(f"• {x['name']} — {x['cell']}" for x in result['entries'])
                    send(f"Записано для студентов: {len(result['entries'])}\n{date_label(dt.date.fromisoformat(result['date']))}, {result['period']} пара\n"
                         f"Предмет: {result['subject']}\nОтметка: {result['mark']}\nЛист «{result['sheet']}»\n{students}",default_keyboard)
                    return True
                send(f"Записано: {result['name']}\n{date_label(dt.date.fromisoformat(result['date']))}, {result['period']} пара\n"
                     f"Отметка: {result['mark']}\nЛист «{result['sheet']}», ячейка {result['cell']}", default_keyboard)
        except (AttendanceError, ScheduleError, ValueError) as exc:
            # Failed preflight/commit requires a new explicit selection.
            self.pending.pop(key, None)
            button = 'Убрать отметку' if pending and pending.get('mode') == 'clear' else 'Отметить пропуск'
            send(str(exc) + f'\nНачни заново кнопкой «{button}».', default_keyboard)
        return True

    @staticmethod
    def ask_reason(send,pending=None):
        prompt = f"Выбрано студентов: {len(pending['selected'])}. Укажи общую причину пропуска:" if pending and pending.get('multi') else 'Укажи основание пропуска:'
        send(prompt, keyboard(['Н — без уважительной причины',
            'Б — справка', 'З — заявление', 'О — объяснительная', 'Отмена']))

    @staticmethod
    def day_lessons(snapshot,day):
        return sorted([dict(period=x.period,subject=x.subject,subgroup=x.subgroup) for x in snapshot.lessons if x.date==day],
                      key=lambda x:(x['period'],x['subgroup'],x['subject']))

    @staticmethod
    def show_students(pending,send):
        names=pending['filtered'][pending['page']:pending['page']+12]
        choices={}
        for full in names:
            label=' '.join(full.split()[:2])
            if sum(' '.join(x.split()[:2])==label for x in pending['names'])>1:
                label=full
            if pending.get('multi') and full in pending.get('selected',[]):
                label='✅ '+label
            choices[label]=full
        pending['student_choices']=choices
        labels=list(choices)
        rows=[[{'text':x} for x in labels[i:i+2]] for i in range(0,len(labels),2)]
        navigation=[]
        if pending['page']>0:navigation.append({'text':'← Назад'})
        if pending['page']+12<len(pending['filtered']):navigation.append({'text':'Далее →'})
        if navigation:rows.append(navigation)
        if pending.get('mode','mark') == 'mark':
            if pending.get('multi'):
                rows.append([{'text':'Выбрать причину'}])
                rows.append([{'text':'Сбросить выбор'},{'text':'Выбирать по одному'}])
            else:
                rows.append([{'text':'Выбрать нескольких'}])
        rows.append([{'text':'Весь список'}])
        rows.append([{'text':'Отмена'}])
        if pending.get('multi'):
            selected=pending.get('selected',[])
            prompt=f'Выбрано: {len(selected)}. Нажимай фамилии, затем «Выбрать причину». Повторное нажатие снимает выбор.'
            if selected:prompt+='\n'+ '\n'.join('✅ '+' '.join(x.split()[:2]) for x in selected)
        else:
            prompt='Выбери студента. Можно написать часть фамилии для поиска.'
        send(prompt,{'keyboard':rows,'resize_keyboard':True})

    def prepare_clear(self, pending, key, send, default_keyboard):
        data = dict(name=pending['name'], date=pending['date'], period=pending['period'])
        result = self.client.call('clear_prepare', username=pending['username'], **data)
        if not result.get('previous'):
            self.pending.pop(key, None)
            send(f"У {result['name']} на этой паре отметки нет — ячейка уже пустая.", default_keyboard)
            return
        data.update(name=result['name'], expected=result['expected'])
        pending.update(prepared=data, stage='confirm')
        send(f"Проверь удаление:\n{result['name']}\n{date_label(dt.date.fromisoformat(result['date']))}, {result['period']} пара\n"
             f"Предмет в таблице: {result['subject'] or 'не указан'}\nТекущая отметка: {result['previous']}\n"
             f"Лист «{result['sheet']}», ячейка {result['cell']}\nБудет очищена только эта отметка.",
             keyboard(['Подтвердить удаление', 'Отмена']))

    def prepare(self, pending, sender, send):
        day = dt.date.fromisoformat(pending['date'])
        snapshot = self.schedule.snapshot_for(day)
        subjects = [pending['subject']] if any(x.date==day and x.period==pending['period'] and
                    x.subject==pending['subject'] and x.subgroup==pending['subgroup'] for x in snapshot.lessons) else []
        if not subjects:
            raise AttendanceError('Этой пары больше нет в расписании. Обнови выбор.')
        data = dict(name=pending['name'], date=pending['date'], period=pending['period'],
                    mark=pending['mark'], attested=pending['attested'],
                    exception=pending.get('exception', False), subjects=subjects,lessons=self.day_lessons(snapshot,day))
        if pending.get('multi'):
            data.pop('name')
            # Use roster order so searching and paging do not change the confirmation order.
            data['names']=[x for x in pending['names'] if x in pending['selected']]
            result = self.client.call('batch_prepare',username=pending['username'],**data)
            data.update(names=[x['name'] for x in result['entries']],expected=result['expected'])
            pending.update(prepared=data,stage='confirm')
            lines=[]
            for entry in result['entries']:
                line=f"• {entry['name']} — {entry['cell']} (сейчас: {entry.get('previous') or 'пусто'})"
                if pending['mark']=='З':line+=f"; дней с З: {entry['daysWithZ']} из 3"
                lines.append(line)
            text=(f"Проверь общую запись для {len(lines)} студентов:\n{date_label(day)}, {result['period']} пара\n"
                  f"Предмет: {result['subject']}\nОбщая отметка: {result['mark']}\nЛист «{result['sheet']}»\n"+'\n'.join(lines))
            if result.get('initialize'):text+='\nВ этом месяце будет добавлена строка дат по образцу сентября.'
            if result.get('headers'):text+='\nПредметы на эту дату будут заполнены с сайта расписания.'
            send(text,keyboard(['Подтвердить запись','Отмена']))
            return
        result = self.client.call('prepare', username=pending['username'], **data)
        data.update(name=result['name'], expected=result['expected'])
        pending.update(prepared=data, stage='confirm')
        previous = result.get('previous') or 'пусто'
        text = (f"Проверь запись:\n{result['name']}\n{date_label(day)}, {result['period']} пара\n"
                f"Предмет в таблице: {result['subject']}\n"
                f"Отметка: {result['mark']} (сейчас: {previous})\n"
                f"Лист «{result['sheet']}», ячейка {result['cell']}")
        if pending['mark'] == 'З':
            text += f"\nДней с З после записи: {result['daysWithZ']} из 3"
        if result.get('initialize'):
            text+='\nДля месяца будет добавлена строка дат по образцу сентября. Список студентов сохранится.'
        if result.get('headers'):
            text+='\nПредметы на эту дату будут заполнены с сайта расписания.'
        send(text, keyboard(['Подтвердить запись', 'Отмена']))
