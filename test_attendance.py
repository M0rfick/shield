import unittest
from attendance import AttendanceClient, AttendanceFlow
from test_bot import fixture
from schedule import ScheduleClient


class FakeClient:
    ready = True

    def __init__(self):
        self.calls = []
        self.previous = 'Н'

    def call(self, action, **data):
        self.calls.append((action, data))
        if action=='roster':
            return dict(ok=True,names=['Иванов Иван Иванович','Петров Пётр Петрович'])
        if action=='pairs':
            return dict(ok=True,pairs=[dict(period=1,subject='ОАП'),dict(period=2,subject='')])
        if action.startswith('clear_'):
            return dict(ok=True,name=data['name'],date=data['date'],period=data['period'],
                        sheet='октябрь',cell='C4',subject='ОАП',expected='hash',previous=self.previous)
        if action.startswith('batch_'):
            return dict(ok=True,date=data['date'],period=data['period'],mark=data['mark'],sheet='октябрь',
                        subject=data['subjects'][0],expected='batch-hash',
                        entries=[dict(name=x,cell=f'K{i+4}',previous='',daysWithZ=i+1) for i,x in enumerate(data['names'])])
        return dict(ok=True, name='Иванов Иван Иванович', date=data['date'], period=data['period'],
                    mark=data['mark'], sheet='октябрь', cell='K4', subject='ОАП', expected='hash', previous='', daysWithZ=1)


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeClient()
        self.flow = AttendanceFlow(self.client, ScheduleClient(fetcher=lambda index: fixture()), allowed_names=['allowed'])
        self.sent = []

    def message(self, text, user=42, username='allowed'):
        self.flow.handle(dict(text=text, chat={'id':1,'type':'private'}, **{'from':{'id':user,'username':username}}),
                         lambda text, keyboard=None:self.sent.append((text, keyboard)), {})

    def begin(self):
        self.message('Иванов Иван — не был')
        self.message('02.10.2026')
        self.message(self.sent[-1][1]['keyboard'][0][0]['text'])

    def test_commit_requires_confirmation(self):
        self.begin()
        self.message('Н — без уважительной причины')
        self.assertEqual([x[0] for x in self.client.calls], ['prepare'])
        self.message('Подтвердить запись')
        self.assertEqual([x[0] for x in self.client.calls], ['prepare','commit'])

    def test_medical_attestation(self):
        self.begin()
        self.message('Б — справка')
        self.assertEqual(self.client.calls, [])
        self.message('Справка проверена и есть в чате')
        self.assertEqual(self.client.calls[-1][1]['attested'], True)

    def test_statement_button_does_not_restart_flow(self):
        self.begin()
        self.message('З — заявление')
        self.message('Заявление в чате, подпись есть')
        self.message('Подтвердить запись')
        self.assertEqual(self.client.calls[-1][1]['mark'], 'З')

    def test_explanation_becomes_absence(self):
        self.begin()
        self.message('О — объяснительная')
        self.message('Записать Н')
        self.assertEqual(self.client.calls[-1][1]['mark'], 'Н')

    def test_curator_exception(self):
        self.begin()
        self.message('О — объяснительная')
        self.message('Куратор согласовал З')
        self.assertEqual(self.client.calls[-1][1]['mark'], 'З')
        self.assertTrue(self.client.calls[-1][1]['exception'])

    def test_username_pinned_to_id(self):
        self.message('/start')
        self.message('Отметить пропуск', user=77)
        self.assertIn('участникам из списка', self.sent[-1][0])

    def test_unconnected_is_reported(self):
        self.flow.client = AttendanceClient()
        self.message('Отметить пропуск')
        self.assertIn('ещё не подключена', self.sent[-1][0])

    def test_date_subject_student_reason_order(self):
        self.message('/miss')
        self.assertIn('дату',self.sent[-1][0])
        self.message('Пт, 02.10.2026')
        labels=[r[0]['text'] for r in self.sent[-1][1]['keyboard']]
        choice=next(x for x in labels if 'Предмет 2' in x)
        self.message(choice)
        self.assertEqual(self.client.calls[-1][0],'roster')
        self.message('Петров')
        self.message('Петров Пётр')
        self.message('Н — без уважительной причины')
        request=self.client.calls[-1][1]
        self.assertEqual(request['name'],'Петров Пётр Петрович')
        self.assertEqual(request['subjects'],['Предмет 2'])
        self.assertEqual(request['period'],4)
        self.assertEqual(len(request['lessons']),3)
        self.assertNotIn('userId',request)
        self.message('Подтвердить запись')
        self.assertEqual(self.client.calls[-1][0],'commit')

    def test_roster_pagination_keeps_full_names(self):
        pending={'names':[f'Студент{i} Имя Отчество' for i in range(25)],'page':12}
        pending['filtered']=pending['names']
        self.flow.show_students(pending,lambda t,k:self.sent.append((t,k)))
        self.assertEqual(pending['student_choices']['Студент12 Имя'],'Студент12 Имя Отчество')
        labels=[x['text'] for row in self.sent[-1][1]['keyboard'] for x in row]
        self.assertIn('Далее →',labels)
        self.assertIn('← Назад',labels)

    def begin_clear(self):
        self.flow.schedule = ScheduleClient(fetcher=lambda index: self.fail('Удаление не должно читать сайт'))
        self.message('/clear')
        self.message('02.10.2026')
        self.message(self.sent[-1][1]['keyboard'][0][0]['text'])
        self.message('Иванов Иван')

    def test_clear_requires_own_confirmation(self):
        self.begin_clear()
        self.assertEqual([x[0] for x in self.client.calls],['pairs','roster','clear_prepare'])
        self.assertIn('Текущая отметка: Н',self.sent[-1][0])
        self.message('Подтвердить запись')
        self.assertNotEqual(self.client.calls[-1][0],'clear_commit')
        self.message('Подтвердить удаление')
        self.assertEqual(self.client.calls[-1][0],'clear_commit')
        self.assertNotIn('lessons',self.client.calls[-1][1])
        self.assertIn('Отметка удалена',self.sent[-1][0])

    def test_clear_cancel_preserves_mark(self):
        self.begin_clear()
        self.message('Отмена')
        self.assertEqual(self.client.calls[-1][0],'clear_prepare')
        self.assertFalse(self.flow.pending)

    def test_clear_empty_cell_finishes_without_commit(self):
        self.client.previous = ''
        self.begin_clear()
        self.assertIn('уже пустая',self.sent[-1][0])
        self.assertFalse(self.flow.pending)

    def begin_multi(self):
        self.message('/miss');self.message('02.10.2026')
        self.message(self.sent[-1][1]['keyboard'][0][0]['text'])
        self.message('Выбрать нескольких')

    def test_multi_selection_common_reason_one_confirmation(self):
        self.begin_multi()
        self.message('Иванов Иван');self.message('Петров Пётр')
        self.assertIn('Выбрано: 2',self.sent[-1][0])
        self.assertEqual([x[0] for x in self.client.calls],['roster'])
        self.message('Выбрать причину');self.message('Н — без уважительной причины')
        self.assertEqual(self.client.calls[-1][0],'batch_prepare')
        self.assertEqual(len(self.client.calls[-1][1]['names']),2)
        self.assertIn('Петров Пётр Петрович',self.sent[-1][0])
        self.message('Подтвердить запись')
        self.assertEqual(self.client.calls[-1][0],'batch_commit')
        self.assertIn('Записано для студентов: 2',self.sent[-1][0])

    def test_multi_deselect_search_and_empty_selection(self):
        self.begin_multi();self.message('Выбрать причину')
        self.assertIn('хотя бы одного',self.sent[-1][0])
        self.message('Иванов Иван');self.message('Петров');self.message('Петров Пётр')
        self.message('Весь список');self.message('✅ Иванов Иван')
        self.message('Выбрать причину');self.message('Н — без уважительной причины')
        self.assertEqual(self.client.calls[-1][1]['names'],['Петров Пётр Петрович'])
        self.message('Отмена')
        self.assertEqual(self.client.calls[-1][0],'batch_prepare')

    def test_multi_can_return_to_single_student(self):
        self.begin_multi();self.message('Иванов Иван');self.message('Выбирать по одному')
        self.message('Петров Пётр');self.message('Н — без уважительной причины')
        self.assertEqual(self.client.calls[-1][0],'prepare')
        self.assertEqual(self.client.calls[-1][1]['name'],'Петров Пётр Петрович')

    def test_multi_medical_confirmation_applies_to_every_student(self):
        self.begin_multi();self.message('Иванов Иван');self.message('Петров Пётр')
        self.message('Выбрать причину');self.message('Б — справка')
        self.assertIn('для каждого',self.sent[-1][0])
        self.assertEqual(self.client.calls[-1][0],'roster')
        self.message('Справка проверена и есть в чате')
        self.assertEqual(self.client.calls[-1][0],'batch_prepare')
        self.assertTrue(self.client.calls[-1][1]['attested'])

    def test_multi_pagination_preserves_other_page_selection(self):
        pending={'mode':'mark','multi':True,'names':[f'Студент{i} Имя Отчество' for i in range(25)],
                 'selected':['Студент0 Имя Отчество','Студент13 Имя Отчество'],'page':12}
        pending['filtered']=pending['names']
        self.flow.show_students(pending,lambda t,k:self.sent.append((t,k)))
        self.assertIn('✅ Студент13 Имя',pending['student_choices'])
        self.assertIn('Студент0 Имя',self.sent[-1][0])

    def test_multi_changed_schedule_prevents_commit(self):
        self.begin_multi();self.message('Иванов Иван');self.message('Выбрать причину')
        self.message('Н — без уважительной причины')
        self.flow.pending[('1','42')]['prepared']['lessons']=[]
        self.message('Подтвердить запись')
        self.assertEqual(self.client.calls[-1][0],'batch_prepare')
        self.assertIn('Расписание изменилось',self.sent[-1][0])


if __name__ == '__main__':
    unittest.main()
