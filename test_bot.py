import datetime as dt
import unittest
from unittest.mock import patch
from bot import Bot, Telegram, chunks
from schedule import GROUP, MissingFile, ScheduleClient, ScheduleError, parse_date, parse_xml


def fixture(start='2026-09-28', day='2026-10-02', extra=''):
    def row(subject, subgroup=0, zam=0):
        return f'''<My><DAT>{day}T00:00:00</DAT><UR>4</UR><IDGG>{subgroup}</IDGG>
        <FAMIO>Преподаватель</FAMIO><SPPRED.NAIM>{subject}</SPPRED.NAIM>
        <SPGRUP.NAIM>{GROUP}</SPGRUP.NAIM><ZAM>{zam}</ZAM><AUD>101</AUD></My>'''
    return (f'<dataroot generated="{start}T12:00:00">' + row('Общий предмет') +
            row('Предмет 1', 1) + row('Предмет 2', 2) + row('Отменён', 0, 2) +
            row('Общий предмет') + extra + '</dataroot>').encode()


class FakeTelegram:
    def __init__(self):
        self.sent = []

    def send(self, chat_id, text, keyboard):
        self.sent.append((chat_id, text, keyboard))

    def send_week(self, chat_id, text, start, keyboard):
        self.sent.append((chat_id, text, keyboard))


class ScheduleTests(unittest.TestCase):
    def test_cancelled_and_duplicate_rows_are_removed(self):
        self.assertEqual(len(parse_xml(fixture()).lessons), 3)

    def test_subgroups_keep_common_classes(self):
        client = ScheduleClient(fetcher=lambda index: fixture())
        text = client.render_day(dt.date(2026, 10, 2), 1)
        self.assertIn('Общий предмет', text)
        self.assertIn('Предмет 1', text)
        self.assertNotIn('Предмет 2', text)
        self.assertNotIn('Отменён', text)

    def test_no_classes_is_different_from_unpublished(self):
        client = ScheduleClient(fetcher=lambda index: fixture())
        self.assertIn('занятий на этот день нет', client.render_day(dt.date(2026, 10, 3)))
        with self.assertRaisesRegex(ScheduleError, 'не опубликовано'):
            client.render_day(dt.date(2026, 10, 20))

    def test_missing_next_file_falls_back_to_matching_dates(self):
        calls = []
        def fetch(index):
            calls.append(index)
            if index != 3:
                raise MissingFile()
            return fixture()
        client = ScheduleClient(fetcher=fetch)
        self.assertIn('09.10.2026', client.render_day(dt.date(2026, 10, 9)))
        self.assertEqual(calls, [4, 3])
        client.render_day(dt.date(2026, 10, 9))
        self.assertEqual(calls, [4, 3])
        client.clear()
        client.render_day(dt.date(2026, 10, 9))
        self.assertEqual(calls, [4, 3, 4, 3])

    def test_newer_valid_file_has_priority(self):
        def fetch(index):
            if index == 4:
                return fixture('2026-10-05', '2026-10-09')
            return fixture()
        client = ScheduleClient(fetcher=fetch)
        self.assertIn('Предмет 1', client.render_day(dt.date(2026, 10, 9)))

    def test_previous_year_is_not_used(self):
        client = ScheduleClient(fetcher=lambda index: fixture('2025-09-28', '2025-10-02'))
        with self.assertRaises(ScheduleError):
            client.render_day(dt.date(2026, 10, 2))

    def test_year_boundary_dates(self):
        client = ScheduleClient(fetcher=lambda index: fixture('2026-12-28', '2027-01-02'))
        self.assertIn('Предмет 1', client.render_day(dt.date(2027, 1, 2)))

    def test_unknown_group_is_not_reported_as_empty_day(self):
        client = ScheduleClient(group='unknown', fetcher=lambda index: fixture())
        with self.assertRaisesRegex(ScheduleError, 'не найдена'):
            client.render_day(dt.date(2026, 10, 2))

    def test_bad_xml_and_entities(self):
        for raw in (b'<html/>', b'<dataroot>', b'<!DOCTYPE dataroot><dataroot/>'):
            with self.assertRaises(ScheduleError):
                parse_xml(raw)

    def test_date_validation_and_leap_day(self):
        self.assertEqual(parse_date('29.02', dt.date(2028, 1, 1)), dt.date(2028, 2, 29))
        with self.assertRaises(ValueError):
            parse_date('31.02.2026')


class BotTests(unittest.TestCase):
    def setUp(self):
        self.telegram = FakeTelegram()
        self.bot = Bot(self.telegram, ScheduleClient(fetcher=lambda index: fixture()))

    def message(self, text, user=7):
        self.bot.handle({'text': text, 'chat': {'id': 12}, 'from': {'id': user}})

    def test_date_message_and_subgroup_selection(self):
        self.message('Подгруппа 1')
        self.message('/date 02.10.2026')
        reply = self.telegram.sent[-1][1]
        self.assertIn('Предмет 1', reply)
        self.assertNotIn('Предмет 2', reply)
        self.message('02.10.2026', user=8)
        self.assertIn('Предмет 2', self.telegram.sent[-1][1])

    def test_date_picker_returns_only_one_chosen_day(self):
        with patch('bot.today', return_value=dt.date(2026, 10, 3)):
            self.message('/date')
            self.assertIn('keyboard', self.telegram.sent[-1][2])
            label = self.telegram.sent[-1][2]['keyboard'][1][0]['text']
            self.assertEqual(label, 'Пн, 05.10.2026')
            self.message(label)
            self.assertEqual(len(self.telegram.sent), 2)
            self.assertIn('05.10.2026', self.telegram.sent[-1][1])
            self.assertNotIn('06.10.2026', self.telegram.sent[-1][1])

    def test_unknown_text_and_empty_updates(self):
        self.message('Иванов был')
        self.assertIn('Выбери кнопку', self.telegram.sent[-1][1])
        self.bot.handle({})
        self.assertEqual(len(self.telegram.sent), 1)

    def test_week_is_one_reply_with_all_days_and_selected_subgroup(self):
        self.bot.state['subgroups']['7'] = 1
        self.message('/week 02.10.2026')
        self.assertEqual(len(self.telegram.sent), 1)
        text = self.telegram.sent[0][1]
        self.assertIn('Понедельник, 28.09.2026', text)
        self.assertIn('Воскресенье, 04.10.2026', text)
        self.assertIn('Предмет 1', text)
        self.assertNotIn('Предмет 2', text)
        with patch('bot.today', return_value=dt.date(2026, 10, 4)):
            self.message('Вся неделя')
        self.assertEqual(self.telegram.sent[0][1], self.telegram.sent[1][1])

    def test_week_keeps_year_boundary_and_unpublished_days(self):
        client = ScheduleClient(fetcher=lambda index: fixture('2026-12-28', '2027-01-02'))
        text = client.render_week(dt.date(2027, 1, 2))
        self.assertIn('28.12.2026', text)
        self.assertIn('03.01.2027', text)
        self.assertIn('Предмет 1', text)
        missing = client.render_week(dt.date(2027, 2, 1))
        self.assertIn('не опубликовано', missing)
        self.assertNotIn('Занятий нет.', missing)

    def test_week_sender_never_splits_or_truncates_long_text(self):
        telegram = Telegram('test-token')
        calls = []
        telegram.call = lambda method, **payload: calls.append((method, payload))
        start = dt.date(2026, 10, 5)
        telegram.send_week(12, 'а' * 4096, start)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[-1][0], 'sendMessage')
        long_text = '😀' * 2049
        telegram.send_week(12, long_text, start)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[-1][0], 'sendDocument')
        self.assertEqual(calls[-1][1]['document'].decode(), long_text)

    def test_large_message_chunks(self):
        parts = list(chunks('а' * 7001))
        self.assertEqual(''.join(parts), 'а' * 7001)
        self.assertTrue(all(len(x) <= 3000 for x in parts))


if __name__ == '__main__':
    unittest.main()
