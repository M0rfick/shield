/** Google Sheets receiver for the Telegram bot. Install in the target spreadsheet. */
const MONTHS = ['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь','ноябрь','декабрь'];

function configure() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.prompt('Подключение бота',
    'Введите Telegram-имена ответственных через запятую, например @Ivan_Morfick, @zxcWenty. Числовые ID не нужны.', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  const names = answer.getResponseText().split(',').map(x => x.trim().replace(/^@/,'').toLowerCase()).filter(Boolean);
  if (!names.length || names.some(x => !/^[a-z0-9_]{5,32}$/.test(x))) throw new Error('Нужны Telegram-имена вида @username.');
  const props = PropertiesService.getScriptProperties();
  const secret = props.getProperty('SHARED_SECRET') || Utilities.getUuid() + Utilities.getUuid();
  props.setProperties({SPREADSHEET_ID: SpreadsheetApp.getActiveSpreadsheet().getId(),
    ALLOWED_USERNAMES: names.join(','), SHARED_SECRET: secret});
  ui.alert('Настройка сохранена',
    'Ключ подключения для SHEETS_SHARED_SECRET:\n' + secret +
    '\n\nХраните его в локальных настройках бота. Затем опубликуйте этот проект как веб-приложение.', ui.ButtonSet.OK);
}

function doGet(e) {
  if(e && e.parameter && e.parameter.health==='telegram') return HtmlService.createHtmlOutput('ok');
  return json_({ok:true,service:'Attendance receiver'});
}

function doPost(e) {
  if(e && e.parameter && e.parameter.health==='telegram') return HtmlService.createHtmlOutput('ok');
  if(e && e.parameter && typeof e.parameter.tg_key==='string') return tgWebhook_(e);
  if(e && typeof e.pathInfo==='string' && e.pathInfo.startsWith('telegram/')) return tgWebhook_(e);
  const lock = LockService.getScriptLock();
  try {
    if (!e || !e.postData || e.postData.contents.length > 20000) throw new Error('Некорректный запрос.');
    const data = JSON.parse(e.postData.contents);
    const props = PropertiesService.getScriptProperties();
    const secret = props.getProperty('SHARED_SECRET');
    if (!secret || typeof data.secret !== 'string' || !constantEqual_(secret,data.secret)) throw new Error('Нет доступа.');
    const names = (props.getProperty('ALLOWED_USERNAMES') || '').split(',');
    if (typeof data.username !== 'string' || !names.includes(data.username.toLowerCase())) throw new Error('Пользователь не назначен ответственным.');
    if (!['prepare','commit','batch_prepare','batch_commit','roster','pairs','clear_prepare','clear_commit','headers_prepare','headers_commit'].includes(data.action)) throw new Error('Неизвестное действие.');
    if (data.action.startsWith('clear_')) validateClearRequest_(data);
    else if (data.action.startsWith('batch_')) validateBatchRequest_(data);
    else if (!['roster','pairs'].includes(data.action)) {
      if (data.action.startsWith('headers_')) validateHeaders_(data); else validateRequest_(data);
    }
    if (!lock.tryLock(10000)) throw new Error('Таблица занята другой записью. Попробуйте ещё раз.');
    const book = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
    if (data.action==='roster') return json_({ok:true,names:roster_(book,data.date)});
    if (data.action==='pairs') return json_({ok:true,pairs:datePairs_(book,data.date)});
    if (data.action.startsWith('clear_')) return clearAttendance_(book,data);
    if (data.action.startsWith('batch_')) return batchAttendance_(book,data);
    if (data.action.startsWith('headers_')) return headers_(book,data);
    validateHeaders_(data);
    const plan = headersPlan_(book,data);
    const target = attendanceTarget_(plan,data);
    const cell = target.sheet.getRange(target.oldRow,target.column);
    if (!cell.canEdit() || cell.isPartOfMerge()) throw new Error('Эта ячейка недоступна для записи.');
    if (cell.getFormula()) throw new Error('В ячейке формула: бот не может заменить её отметкой.');
    validateCell_(cell,data.mark);
    const previous = String(cell.getValue() || '').trim();
    if (!['','Н','Б','З','О'].includes(previous.toUpperCase())) throw new Error('В ячейке другая запись. Проверьте её вручную.');
    const row = target.sheet.getRange(target.oldRow,1,1,target.width).getDisplayValues()[0];
    const zDays = plan.initialize ? (data.mark==='З'?1:0) : countDaysWithZ_(row,target.dates,data.date,data.mark);
    if (data.mark === 'З' && zDays > 3) throw new Error('Лимит З исчерпан: не более трёх разных дней за месяц.');
    const expected = digest_([target.sheet.getSheetId(),target.row,target.column,previous,
      target.name,target.subject,data.date,data.period,data.mark,plan.expected].join('|'));
    const result = {ok:true,name:target.name,date:data.date,period:data.period,mark:data.mark,
      sheet:target.sheet.getName(),cell:target.sheet.getRange(target.row,target.column).getA1Notation(),subject:target.subject,
      previous:previous,expected:expected,daysWithZ:zDays,headers:plan.changes,initialize:plan.initialize};
    if (data.action === 'prepare') return json_(result);
    if (data.expected !== expected) throw new Error('Ячейка или заголовок изменились после подтверждения. Начните запись заново.');
    applyHeaders_(book,plan);
    const savedCell=target.sheet.getRange(target.row,target.column);
    savedCell.setValue(data.mark);
    SpreadsheetApp.flush();
    if (savedCell.getDisplayValue() !== data.mark) throw new Error('Не удалось подтвердить сохранение отметки.');
    return json_(result);
  } catch (error) {
    return json_({ok:false,error: String(error.message || 'Ошибка записи в таблицу.')});
  } finally {
    if (lock.hasLock()) lock.releaseLock();
  }
}

function roster_(book,date) {
  if(typeof date!=='string'||!/^20\d\d-\d\d-\d\d$/.test(date))throw new Error('Неверная дата.');
  const sheet=book.getSheetByName(MONTHS[Number(date.slice(5,7))-1]);
  if(!sheet)throw new Error('Нет списка группы для выбранного месяца.');
  const top=sheet.getRange(1,2,Math.min(8,sheet.getLastRow()),1).getDisplayValues();
  const header=top.findIndex(x=>normalize_(x[0])==='фио');
  if(header<0)throw new Error('Не найден список ФИО.');
  const rows=sheet.getRange(header+2,1,sheet.getLastRow()-header-1,2).getDisplayValues(),names=[];
  for(const row of rows){if(!/^\d+$/.test(row[0])||!row[1].trim())break;names.push(row[1].trim());}
  if(!names.length||names.length>100)throw new Error('Проверьте список группы в таблице.');
  return names;
}

function attendanceTarget_(plan,data,roster,dates) {
  const sheet=plan.sheet;
  const names=roster||sheet.getRange(plan.header+2,2,plan.count,1).getDisplayValues();
  const wanted=normalize_(data.name),found=[];
  names.forEach((row,index)=>{const name=normalize_(row[0]);if(name===wanted||name.startsWith(wanted+' '))found.push({name:row[0],oldRow:plan.header+2+index});});
  if(found.length!==1)throw new Error(found.length?'Есть несколько совпадений. Выберите полное ФИО.':'Студент не найден в списке месяца.');
  const subject=plan.labels[data.period-1];
  if(!data.subjects.some(x=>subject.split(' / ').some(part=>subjectMatches_(part,x))))throw new Error('Выбранный предмет больше не совпадает с расписанием. Выберите пару заново.');
  return {sheet,row:found[0].oldRow+(plan.initialize&&plan.header===1?1:0),oldRow:found[0].oldRow,
    column:plan.start+data.period-1,name:found[0].name,subject,width:sheet.getLastColumn(),
    dates:dates||(plan.initialize?[]:dateBlocks_(sheet.getRange(plan.header,1,1,sheet.getLastColumn()).getValues()[0],sheet.getParent().getSpreadsheetTimeZone()))};
}

function validateRequest_(data) {
  if (typeof data.name !== 'string' || data.name.length > 150 || normalize_(data.name).split(' ').length < 2)
    throw new Error('Нужны фамилия и имя.');
  if (typeof data.date !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(data.date)) throw new Error('Неверная дата.');
  const day = new Date(data.date + 'T12:00:00Z');
  if (isNaN(day.getTime()) || day.toISOString().slice(0,10) !== data.date) throw new Error('Неверная дата.');
  if (!Number.isInteger(data.period) || data.period < 1 || data.period > 5) throw new Error('Неверный номер пары.');
  if (!['Н','Б','З'].includes(data.mark)) throw new Error('Недопустимая отметка. Объяснительная отмечается Н.');
  if (['Б','З'].includes(data.mark) && data.attested !== true) throw new Error('Нужно подтверждение проверки документов ответственным.');
  if (!Array.isArray(data.subjects) || !data.subjects.length || data.subjects.some(x => typeof x !== 'string' || x.length > 300))
    throw new Error('Не передан предмет из расписания.');
}

function locate_(book,data) {
  const sheet = book.getSheetByName(MONTHS[Number(data.date.slice(5,7))-1]);
  if (!sheet) throw new Error('Нет листа для этого месяца.');
  const width = sheet.getLastColumn(),height=sheet.getLastRow();
  if (width < 3 || height < 3) throw new Error('Лист ещё не подготовлен.');
  const values = sheet.getRange(1,1,Math.min(8,height),width).getValues();
  let header=-1;
  for (let r=0;r<values.length;r++) if (normalize_(values[r][1]) === 'фио') {header=r;break;}
  if (header < 1) throw new Error('Не найден заголовок ФИО и строка дат над ним.');
  const dateRow=header-1;
  const dates=dateBlocks_(values[dateRow],book.getSpreadsheetTimeZone());
  const matches=dates.filter(x => x.date === data.date);
  if (matches.length !== 1) throw new Error('Дата отсутствует в таблице или встречается дважды. Бот не добавляет её автоматически.');
  const block=matches[0];
  if (block.end-block.start !== 5) throw new Error('Для этой даты нужно проверить пять столбцов пар в таблице.');
  const column=block.start+data.period-1;
  const subject=String(values[header][column] || '').trim();
  if (!subject && !data.action.startsWith('clear_')) throw new Error('В таблице не указан предмет для выбранной пары. Сначала заполните заголовок.');
  if (!data.action.startsWith('clear_') && !data.subjects.some(x => subject.split(' / ').some(part=>subjectMatches_(part,x))))
    throw new Error('Предмет в таблице не совпал с расписанием: «' + subject + '». Проверьте заголовок вручную.');
  const names=sheet.getRange(header+2,2,height-header-1,1).getDisplayValues();
  const wanted=normalize_(data.name),found=[];
  names.forEach((row,index) => {
    const name=normalize_(row[0]);
    if (name === wanted || name.startsWith(wanted+' ')) found.push({name:row[0],row:header+2+index});
  });
  if (found.length !== 1) throw new Error(found.length ? 'Есть несколько совпадений. Укажите полное ФИО.' : 'Человек не найден в списке этого месяца.');
  return {sheet:sheet,row:found[0].row,name:found[0].name,column:column+1,subject:subject,dates:dates,width:width};
}

function dateBlocks_(row,timezone) {
  const blocks=[];
  row.forEach((value,index) => {
    let date='';
    if (value instanceof Date && !isNaN(value.getTime())) date=Utilities.formatDate(value,timezone,'yyyy-MM-dd');
    else if (typeof value === 'string' && /^\d\d\.\d\d\.20\d\d$/.test(value.trim())) {
      const parts=value.trim().split('.');date=parts[2]+'-'+parts[1]+'-'+parts[0];
    }
    // An actual year is required so an old workbook cannot silently receive new-year marks.
    if (date && index>=2) blocks.push({date:date,start:index,end:Math.min(index+5,row.length)});
  });
  for (let i=0;i<blocks.length-1;i++) blocks[i].end=Math.min(blocks[i].end,blocks[i+1].start);
  return blocks;
}

function countDaysWithZ_(row,blocks,date,mark) {
  const days=new Set();
  blocks.forEach(block => {
    if (block.date.slice(0,7) !== date.slice(0,7)) return;
    if (row.slice(block.start,block.end).some(x => String(x).trim().toUpperCase()==='З')) days.add(block.date);
  });
  if (mark === 'З') days.add(date);
  return days.size;
}

function subjectMatches_(header,subject) {
  const normalize=x=>normalize_(x).replace(/[^а-яa-z0-9]/g,'');
  const a=normalize(header),b=normalize(subject);
  if (a === b) return true;
  const aliases=[['оап','оап'],['опбд','опбд'],['матапп','матемаппаратвотрит'],
    ['оиб','основыинформационнойбезопасности'],['осис','осис'],['история','историяроссии'],
    ['иняз1','инязвпд'],['иняз2','инязвпд'],['иняз','инязвпд'],
    ['бпла07','мдк0701операторбеспилотныхавиационныхсистем'],['оснрабсинф','основыработысинформацией'],
    ['ит12','итвпрофдеят'],['ит1','итвпрофдеят'],['ит2','итвпрофдеят'],['дм','дмсэмл'],
    ['дмсэмл','дмсэмл'],['аас','архитектурааппаратныхсредств'],['арх','архитектурааппаратныхсредств'],
    ['упритпроект','управлениеитпроектами'],['физра','физическультура'],['физра','физическаякультура']];
  return aliases.some(pair=>a===pair[0]&&b===pair[1]);
}

function validateCell_(cell,mark) {
  const rule=cell.getDataValidation();if (!rule) return;
  const type=rule.getCriteriaType(),args=rule.getCriteriaValues();
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST && args[0].map(String).includes(mark)) return;
  if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE && args[0].getDisplayValues().flat().includes(mark)) return;
  throw new Error('Проверка данных в ячейке не разрешает эту отметку.');
}
function normalize_(value) {return String(value || '').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim();}
function constantEqual_(a,b) {let diff=a.length^b.length;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^(b.charCodeAt(i)||0);return diff===0;}
function digest_(value) {return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,value));}
function json_(value) {return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);}
