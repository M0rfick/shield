"""Live schedule adapter for polytech-shedule.ru; Python 3.9+, no dependencies."""
import datetime as dt
import re
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Optional

BASE_URL = 'https://polytech-shedule.ru'
GROUP = '26290911/3112'
MOSCOW = dt.timezone(dt.timedelta(hours=3))
DAYS = ('Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье')


class ScheduleError(Exception):
    pass


class MissingFile(ScheduleError):
    pass


@dataclass(frozen=True)
class Lesson:
    date: dt.date
    period: int
    subject: str
    teacher: str
    subgroup: int
    room: str
    campus: str
    change: str
    note: str


@dataclass
class Snapshot:
    start: dt.date
    lessons: list
    groups: set
    fetched: dt.datetime

    def covers(self, day):
        return self.start <= day < self.start + dt.timedelta(days=14)


def today():
    return dt.datetime.now(MOSCOW).date()


def parse_date(text, reference=None):
    reference = reference or today()
    text = re.sub(r'^(?:Пн|Вт|Ср|Чт|Пт|Сб|Вс),\s*', '', text, flags=re.I)
    for fmt in ('%d.%m.%Y', '%Y-%m-%d', '%d.%m'):
        try:
            # Supply the year before parsing so 29.02 works in leap years.
            value = text + '.' + str(reference.year) if fmt == '%d.%m' else text
            return dt.datetime.strptime(value, '%d.%m.%Y' if fmt == '%d.%m' else fmt).date()
        except ValueError:
            pass
    raise ValueError('Напиши дату в формате ДД.ММ.ГГГГ, например 05.10.2026.')


def date_label(day):
    return f"{('Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс')[day.weekday()]}, {day:%d.%m.%Y}"


def parse_xml(raw, group=GROUP):
    if b'<!DOCTYPE' in raw.upper() or b'<!ENTITY' in raw.upper():
        raise ScheduleError('Сайт вернул неподдерживаемый формат расписания.')
    try:
        root = ET.fromstring(raw)
        if root.tag != 'dataroot' or not root.findall('My'):
            raise ValueError('schema')
        start = dt.date.fromisoformat(root.attrib['generated'][:10])
        groups, lessons, seen = set(), [], set()
        for row in root.findall('My'):
            def field(name):
                return (row.findtext(name) or '').strip()
            row_group = field('SPGRUP.NAIM')
            groups.add(row_group)
            if row_group != group or field('ZAM') == '2':
                continue
            lesson = Lesson(
                dt.date.fromisoformat(field('DAT')[:10]), int(field('UR')),
                field('SPPRED.NAIM'), field('FAMIO'), int(field('IDGG') or 0),
                field('AUD'), field('CAMPUS'), field('ZAM'), field('NOTE'))
            if lesson.period < 1 or not lesson.subject:
                raise ValueError('lesson')
            if lesson not in seen:
                seen.add(lesson)
                lessons.append(lesson)
    except (ET.ParseError, KeyError, ValueError) as exc:
        raise ScheduleError('Не удалось прочитать расписание: формат сайта изменился.') from exc
    return Snapshot(start, sorted(lessons, key=lambda x: (x.date, x.period, x.subgroup, x.subject)),
                    groups, dt.datetime.now(MOSCOW))


def fetch_xml(index):
    request = urllib.request.Request(
        f'{BASE_URL}/data/{index}.xml', headers={'User-Agent': 'PolytechScheduleBot/1.0'})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            raw = response.read(8_000_001)
        if len(raw) > 8_000_000:
            raise ScheduleError('Файл расписания слишком большой.')
        return raw
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise MissingFile('Расписание пока не опубликовано.') from exc
        raise ScheduleError('Сайт расписания временно недоступен. Попробуй позже.') from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ScheduleError('Не удалось подключиться к сайту расписания. Попробуй позже.') from exc


class ScheduleClient:
    def __init__(self, group=GROUP, fetcher=fetch_xml):
        self.group, self.fetcher, self.cache = group, fetcher, {}

    def clear(self):
        self.cache.clear()

    def load(self, index):
        cached = self.cache.get(index)
        if cached and time.monotonic() - cached[0] < 120:
            if isinstance(cached[1], MissingFile):
                raise cached[1]
            return cached[1]
        try:
            snapshot = parse_xml(self.fetcher(index), self.group)
        except MissingFile as exc:
            self.cache[index] = (time.monotonic(), exc)
            raise
        self.cache[index] = (time.monotonic(), snapshot)
        return snapshot

    def snapshot_for(self, day):
        if day.month in (7, 8):
            raise ScheduleError('Расписание на эту дату нужно проверить на сайте: вне учебного периода.')
        year = day.year if day.month >= 9 else day.year - 1
        elapsed = (day - dt.date(year, 9, 1)).days
        index = max(1, min(20, elapsed // 14 + 1))
        preferred = index + 1 if elapsed % 14 >= 7 else index
        # Follow the site's current/next-file rule. Verify actual dates before
        # using a file; neighbouring files handle the September calendar offset.
        candidates = list(dict.fromkeys([preferred, index, index - 1, index + 1]))
        error = None
        for candidate in candidates:
            if not 1 <= candidate <= 21:
                continue
            try:
                snapshot = self.load(candidate)
            except MissingFile:
                continue
            except ScheduleError as exc:
                error = exc
                continue
            if snapshot.covers(day):
                if self.group not in snapshot.groups:
                    raise ScheduleError(f'Группа {self.group} не найдена в расписании на этот период.')
                return snapshot
        if error:
            raise error
        raise ScheduleError('Расписание на эту дату пока не опубликовано на сайте.')

    def render_day(self, day, subgroup=0):
        snapshot = self.snapshot_for(day)
        lessons = [x for x in snapshot.lessons if x.date == day and
                   (subgroup == 0 or x.subgroup in (0, subgroup))]
        lines = [f'{DAYS[day.weekday()]}, {day:%d.%m.%Y}', f'Группа {self.group}']
        if subgroup:
            lines.append(f'Подгруппа {subgroup}')
        lines.append('')
        if not lessons:
            lines.append('На сайте занятий на этот день нет.' if not subgroup else
                         'На сайте занятий для выбранной подгруппы на этот день нет.')
        for item in lessons:
            suffix = f' · подгруппа {item.subgroup}' if item.subgroup else ''
            lines.append(f'{item.period} пара — {item.subject}{suffix}')
            if item.teacher:
                lines.append(item.teacher)
            campus = {'Э': 'Энгельса', 'П': 'Приморский', 'О': 'Онлайн'}.get(item.campus, item.campus)
            location = [part for part in (f'Аудитория: {item.room}' if item.room else '', campus) if part]
            if location:
                lines.append(' · '.join(location))
            if item.change in ('1', '3'):
                lines.append('Изменение в расписании' if item.change == '1' else 'Консультация (к)')
            if item.note:
                lines.append(item.note)
            lines.append('')
        lines.append(f'Проверено на сайте: {snapshot.fetched:%d.%m %H:%M} МСК')
        lines.append(BASE_URL)
        return '\n'.join(lines)

    def render_week(self, start, subgroup=0):
        start -= dt.timedelta(days=start.weekday())
        end = start + dt.timedelta(days=6)
        lines = [f'Расписание: {start:%d.%m.%Y} — {end:%d.%m.%Y}', f'Группа {self.group}']
        if subgroup:
            lines.append(f'Подгруппа {subgroup}')
        snapshot = None
        for i in range(7):
            day = start + dt.timedelta(days=i)
            lines.extend(('', f'{DAYS[day.weekday()]}, {day:%d.%m.%Y}'))
            try:
                if not snapshot or not snapshot.covers(day):
                    snapshot = self.snapshot_for(day)
                lessons = [x for x in snapshot.lessons if x.date == day and
                           (not subgroup or x.subgroup in (0, subgroup))]
                if not lessons:
                    lines.append('Занятий нет.')
                for item in lessons:
                    suffix = f' · подгр. {item.subgroup}' if item.subgroup else ''
                    lines.append(f'{item.period} пара — {item.subject}{suffix}')
                    campus = {'Э': 'Энгельса', 'П': 'Приморский', 'О': 'Онлайн'}.get(item.campus, item.campus)
                    details = [x for x in (item.teacher, f'ауд. {item.room}' if item.room else '', campus) if x]
                    if details:
                        lines.append(' · '.join(details))
                    if item.change in ('1', '3'):
                        lines.append('Изменение в расписании' if item.change == '1' else 'Консультация (к)')
                    if item.note:
                        lines.append(item.note)
            except ScheduleError as exc:
                lines.append(str(exc))
        lines.extend(('', BASE_URL))
        return '\n'.join(lines)
