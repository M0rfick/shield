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

function doGet() { return json_({ok:true,service:'Attendance receiver'}); }

function doPost(e) {
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


/** Date and subject headers. Loaded alongside Attendance.gs. */
function validateHeaders_(data) {
  if (typeof data.date!=='string'||!/^20\d\d-\d\d-\d\d$/.test(data.date)) throw new Error('Неверная дата.');
  const day=new Date(data.date+'T12:00:00Z');
  if (isNaN(day.getTime())||day.toISOString().slice(0,10)!==data.date) throw new Error('Неверная дата.');
  if (day.getUTCDay()===0) throw new Error('В шаблоне таблицы нет воскресений.');
  if (!Array.isArray(data.lessons)||!data.lessons.length||data.lessons.length>30) throw new Error('Нет опубликованных предметов для этой даты.');
  data.lessons.forEach(x=>{
    if (!Number.isInteger(x.period)||x.period<1||x.period>5||typeof x.subject!=='string'||!x.subject.trim()||x.subject.length>300||![0,1,2].includes(x.subgroup))
      throw new Error('В таблице предусмотрены пять пар и две подгруппы. Проверьте расписание.');
  });
}

function monthDays_(date) {
  const year=Number(date.slice(0,4)),month=Number(date.slice(5,7)),days=[];
  for(let n=1;n<=31;n++) {
    const d=new Date(Date.UTC(year,month-1,n,12));
    if(d.getUTCMonth()!==month-1)break;
    if(d.getUTCDay()!==0)days.push(d.toISOString().slice(0,10));
  }
  return days;
}

function headerSubjects_(lessons) {
  const names={'матемаппаратвотрит':'Мат апп','основыинформационнойбезопасности':'ОИБ',
    'историяроссии':'История','мдк0701операторбеспилотныхавиационныхсистем':'БПЛА 07',
    'основыработысинформацией':'Осн раб с инф','итвпрофдеят':'ИТ','дмсэмл':'ДМ',
    'архитектурааппаратныхсредств':'ААС','управлениеитпроектами':'Упр ИТ проект',
    'физическультура':'Физра','физическаякультура':'Физра'};
  const result=Array(5).fill('');
  for(let period=1;period<=5;period++) {
    const labels=lessons.filter(x=>x.period===period).sort((a,b)=>a.subgroup-b.subgroup||a.subject.localeCompare(b.subject)).map(x=>{
      const key=normalize_(x.subject).replace(/[^а-яa-z0-9]/g,'');
      if(key==='инязвпд')return 'Ин.яз'+(x.subgroup?' '+x.subgroup:'');
      if(key==='итвпрофдеят'&&x.subgroup)return 'ИТ '+x.subgroup;
      return names[key]||x.subject;
    });
    result[period-1]=[...new Set(labels)].join(' / ');
  }
  return result;
}

function headersPlan_(book,data) {
  const sheet=book.getSheetByName(MONTHS[Number(data.date.slice(5,7))-1]);
  if(!sheet)throw new Error('Нет листа для этого месяца. Сначала добавьте лист со списком группы.');
  const width=sheet.getLastColumn(),height=sheet.getLastRow();
  if(width<3||height<3)throw new Error('Нет подготовленной таблицы со списком группы.');
  const top=sheet.getRange(1,1,Math.min(8,height),width).getValues();
  let header=-1;
  for(let r=0;r<top.length;r++)if(normalize_(top[r][1])==='фио'){header=r;break;}
  if(![1,2].includes(header))throw new Error('Нужен шаблон как в сентябре: дни недели, даты, предметы и ФИО.');
  let count=0;
  const roster=sheet.getRange(header+2,1,height-header-1,2).getDisplayValues();
  for(const row of roster){if(!/^\d+$/.test(row[0])||!row[1].trim())break;count++;}
  if(!count)throw new Error('В этом месяце не найден список студентов.');
  const dates=dateBlocks_(top[header-1],book.getSpreadsheetTimeZone());
  const initialize=dates.length===0;
  const calendar=monthDays_(data.date),neededWidth=calendar.length*5;
  let start,subjectsRow=header+1,previous;
  if(initialize) {
    if(width<neededWidth+2||sheet.getMaxColumns()<neededWidth+2)throw new Error('В шаблоне недостаточно столбцов для месяца.');
    const blank=sheet.getRange(header+1,3,count+1,neededWidth);
    if(blank.getDisplayValues().flat().some(x=>String(x).trim())||blank.getFormulas().flat().some(Boolean))
      throw new Error('В неподготовленном месяце уже есть предметы или отметки. Даты нужно проверить вручную.');
    if(!sheet.getRange(1,3,header+1,neededWidth).canEdit())throw new Error('Нет права заполнять заголовки месяца.');
    const template=book.getSheetByName('сентябрь');
    if(!template||normalize_(template.getRange(3,2).getDisplayValue())!=='фио')throw new Error('Не найден образец сентября.');
    start=3+calendar.indexOf(data.date)*5; subjectsRow=3; previous=Array(5).fill('');
  } else {
    const matches=dates.filter(x=>x.date===data.date);
    if(matches.length!==1||matches[0].end-matches[0].start!==5)throw new Error('В таблице нет однозначного блока из пяти пар для этой даты.');
    start=matches[0].start+1;
    previous=top[header].slice(start-1,start+4).map(x=>String(x||'').trim());
  }
  const labels=headerSubjects_(data.lessons);
  // Keep existing abbreviations when they represent every published subgroup.
  labels.forEach((label,index)=>{
    const published=data.lessons.filter(x=>x.period===index+1);
    const parts=previous[index].split(' / ');
    if(previous[index]&&published.length&&published.every(x=>parts.some(p=>subjectMatches_(p,x.subject)))&&parts.every(p=>published.some(x=>subjectMatches_(p,x.subject))))
      labels[index]=previous[index];
  });
  const changes=[];
  labels.forEach((label,index)=>{
    if(label===previous[index])return;
    if(!initialize) {
      const cell=sheet.getRange(subjectsRow,start+index);
      if(!cell.canEdit()||cell.isPartOfMerge()||cell.getFormula())throw new Error('Заголовок пары недоступен для заполнения.');
    }
    changes.push({period:index+1,previous:previous[index],subject:label});
  });
  const inspected=sheet.getRange(1,1,header+1+count,width);
  const expected=digest_(JSON.stringify([sheet.getSheetId(),data.date,data.lessons,inspected.getValues(),inspected.getFormulas()]));
  return {sheet,start,subjectsRow,header,initialize,calendar,labels,changes,expected,count};
}

function headers_(book,data) {
  const plan=headersPlan_(book,data);
  const result={ok:true,date:data.date,sheet:plan.sheet.getName(),subjects:plan.labels,changes:plan.changes,
    initialize:plan.initialize,days:plan.calendar.length,expected:plan.expected};
  if(data.action==='headers_prepare')return json_(result);
  if(data.expected!==plan.expected)throw new Error('Таблица изменилась после предварительного просмотра. Выберите дату заново.');
  applyHeaders_(book,plan);
  return json_(result);
}

function applyHeaders_(book,plan) {
  const sheet=plan.sheet;
  if(plan.initialize) {
    if(plan.header===1)sheet.insertRowsBefore(2,1);
    const template=book.getSheetByName('сентябрь');
    sheet.setRowHeight(2,template.getRowHeight(2));
    sheet.setRowHeight(3,template.getRowHeight(3));
    const weekdays=['Воскресенье','Понедельник','Вторник','Среда','Четверг','Пятница','Суббота'];
    plan.calendar.forEach((date,index)=>{
      const col=3+index*5;
      const weekday=sheet.getRange(1,col,1,5),day=sheet.getRange(2,col,1,5);
      // The prepared template has five columns per day. Merge only empty date blocks.
      day.merge();
      template.getRange(2,3,1,5).copyTo(day,{formatOnly:true});
      day.setNumberFormat('dd.MM');
      sheet.getRange(2,col).setValue(Utilities.parseDate(date,book.getSpreadsheetTimeZone(),'yyyy-MM-dd'));
      sheet.getRange(1,col).setValue(weekdays[new Date(date+'T12:00:00Z').getUTCDay()]);
      template.getRange(3,3,1,5).copyTo(sheet.getRange(3,col,1,5),{formatOnly:true});
    });
  }
  plan.changes.forEach(change=>sheet.getRange(plan.subjectsRow,plan.start+change.period-1).setValue(change.subject));
  SpreadsheetApp.flush();
  const saved=sheet.getRange(plan.subjectsRow,plan.start,1,5).getDisplayValues()[0];
  if(saved.some((x,index)=>String(x).trim()!==plan.labels[index]))throw new Error('Не удалось подтвердить сохранение предметов. Проверьте выбранную дату в таблице.');
}


/** Clear one attendance cell. Never changes date/subject headers or student lists. */
function validateClearRequest_(data) {
  if(typeof data.name!=='string'||data.name.length>150||normalize_(data.name).split(' ').length<2)throw new Error('Выберите студента.');
  const day=new Date(data.date+'T12:00:00Z');
  if(typeof data.date!=='string'||!/^20\d\d-\d\d-\d\d$/.test(data.date)||isNaN(day.getTime())||day.toISOString().slice(0,10)!==data.date)throw new Error('Неверная дата.');
  if(!Number.isInteger(data.period)||data.period<1||data.period>5)throw new Error('Неверный номер пары.');
}

function datePairs_(book,date) {
  const day=new Date(date+'T12:00:00Z');
  if(typeof date!=='string'||!/^20\d\d-\d\d-\d\d$/.test(date)||isNaN(day.getTime())||day.toISOString().slice(0,10)!==date)throw new Error('Неверная дата.');
  const sheet=book.getSheetByName(MONTHS[Number(date.slice(5,7))-1]);
  if(!sheet)throw new Error('Нет листа для этого месяца.');
  const values=sheet.getRange(1,1,Math.min(8,sheet.getLastRow()),sheet.getLastColumn()).getValues();
  const header=values.findIndex(row=>normalize_(row[1])==='фио');
  if(header<1)throw new Error('Не найдена строка дат над ФИО.');
  const blocks=dateBlocks_(values[header-1],book.getSpreadsheetTimeZone()).filter(x=>x.date===date);
  if(blocks.length!==1||blocks[0].end-blocks[0].start!==5)throw new Error('В таблице нет блока из пяти пар для этой даты.');
  return Array.from({length:5},(_,i)=>({period:i+1,subject:String(values[header][blocks[0].start+i]||'').trim()}));
}

function clearAttendance_(book,data) {
  const target=locate_(book,data),cell=target.sheet.getRange(target.row,target.column);
  if(!cell.canEdit()||cell.isPartOfMerge())throw new Error('Эта ячейка недоступна для удаления отметки.');
  if(cell.getFormula())throw new Error('В ячейке формула. Бот не удаляет формулы.');
  const previous=String(cell.getValue()||'').trim();
  if(!['','Н','Б','З','О'].includes(previous.toUpperCase()))throw new Error('В ячейке другая запись. Бот удаляет только отметки посещаемости.');
  const expected=digest_(['clear',target.sheet.getSheetId(),target.row,target.column,target.name,target.subject,data.date,data.period,previous].join('|'));
  const result={ok:true,name:target.name,date:data.date,period:data.period,sheet:target.sheet.getName(),cell:cell.getA1Notation(),subject:target.subject,previous,expected};
  if(data.action==='clear_prepare')return json_(result);
  if(!previous)return json_(Object.assign(result,{unchanged:true}));
  if(data.expected!==expected)throw new Error('Отметка или заголовок изменились после просмотра. Выберите студента и пару заново.');
  cell.clearContent();SpreadsheetApp.flush();
  if(String(cell.getValue()||'').trim())throw new Error('Не удалось подтвердить удаление отметки. Проверьте ячейку в таблице.');
  return json_(result);
}


/** One pair and one reason for a selected list of students. */
function validateBatchRequest_(data) {
  if(!Array.isArray(data.names)||!data.names.length||data.names.length>100)throw new Error('Выберите от одного до ста студентов.');
  data.names.forEach(name=>validateRequest_(Object.assign({},data,{name})));
  if(new Set(data.names.map(normalize_)).size!==data.names.length)throw new Error('Студент выбран дважды.');
  validateHeaders_(data);
}

function batchAttendance_(book,data) {
  const plan=headersPlan_(book,data),sheet=plan.sheet;
  const roster=sheet.getRange(plan.header+2,2,plan.count,1).getDisplayValues();
  const grid=sheet.getRange(plan.header+2,1,plan.count,sheet.getLastColumn()).getValues();
  const dates=plan.initialize?[]:dateBlocks_(sheet.getRange(plan.header,1,1,sheet.getLastColumn()).getValues()[0],book.getSpreadsheetTimeZone());
  // Check every student before writing headers or any marks.
  const entries=data.names.map(name=>{
    try {
      const target=attendanceTarget_(plan,Object.assign({},data,{name}),roster,dates);
      const cell=sheet.getRange(target.oldRow,target.column);
      if(!cell.canEdit()||cell.isPartOfMerge())throw new Error('Ячейка недоступна для записи.');
      if(cell.getFormula())throw new Error('В ячейке формула: бот не заменяет её отметкой.');
      validateCell_(cell,data.mark);
      const row=grid[target.oldRow-plan.header-2],previous=String(row[target.column-1]||'').trim();
      if(!['','Н','Б','З','О'].includes(previous.toUpperCase()))throw new Error('В ячейке другая запись.');
      const daysWithZ=plan.initialize?(data.mark==='З'?1:0):countDaysWithZ_(row,dates,data.date,data.mark);
      if(data.mark==='З'&&daysWithZ>3)throw new Error('Лимит З исчерпан: не более трёх разных дней за месяц.');
      return {name:target.name,cell:sheet.getRange(target.row,target.column).getA1Notation(),previous,daysWithZ};
    } catch(error) {throw new Error(name+': '+error.message);}
  });
  if(new Set(entries.map(x=>x.cell)).size!==entries.length)throw new Error('Несколько выбранных имён соответствуют одному студенту.');
  const expected=digest_(JSON.stringify(['batch',plan.expected,data.mark,entries]));
  const result={ok:true,date:data.date,period:data.period,mark:data.mark,subject:plan.labels[data.period-1],
    sheet:sheet.getName(),entries,expected,headers:plan.changes,initialize:plan.initialize};
  if(data.action==='batch_prepare')return json_(result);
  if(data.expected!==expected)throw new Error('Таблица изменилась после просмотра. Выберите студентов и пару заново.');
  applyHeaders_(book,plan);
  sheet.getRangeList(entries.map(x=>x.cell)).setValue(data.mark);
  SpreadsheetApp.flush();
  if(entries.some(x=>sheet.getRange(x.cell).getDisplayValue()!==data.mark))
    throw new Error('Не удалось подтвердить все отметки. Проверьте выбранных студентов в таблице перед повторной записью.');
  return json_(result);
}


/** Free cloud runtime. No token in source. Uses the existing attendance receiver. */
const TG_GROUP='26290911/3112';
const TG_MAIN=[['Сегодня','Завтра'],['Выбрать дату','Выбрать подгруппу'],['Отметить пропуск','Убрать отметку'],['Обновить']];
const TG_DATE=['Сегодня','Завтра','Вчера','Другая дата','Отмена'];
const TG_REASONS=['Н — без уважительной причины','Б — справка','З — заявление','О — объяснительная','Отмена'];

function configureCloudBot() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const p=PropertiesService.getScriptProperties();
  if(!p.getProperty('SPREADSHEET_ID')||!p.getProperty('SHARED_SECRET')||!p.getProperty('ALLOWED_USERNAMES'))
    throw new Error('Сначала подключите таблицу функцией configure.');
  let token=p.getProperty('TELEGRAM_BOT_TOKEN');
  if(!token) {
    let ui;try {ui=SpreadsheetApp.getUi();}catch(error){throw new Error('Откройте настройки проекта → свойства скрипта. Добавьте TELEGRAM_BOT_TOKEN со значением токена и повторите configureCloudBot.');}
    const answer=ui.prompt('Бесплатный облачный бот','Введите токен @Schedule3112bot из BotFather. Он сохранится только в свойствах Google-скрипта.',ui.ButtonSet.OK_CANCEL);
    if(answer.getSelectedButton()!==ui.Button.OK)return;
    token=answer.getResponseText().trim();
  }
  if(!/^\d+:[A-Za-z0-9_-]+$/.test(token))throw new Error('Неверный формат токена.');
  const identity=tgApi_('getMe',{},token);
  if(identity.username!=='Schedule3112bot')throw new Error('Это токен другого бота.');
  p.setProperty('TELEGRAM_BOT_TOKEN',token);
  console.log('Токен проверен и сохранён. Сначала остановите копию на ноутбуке, затем выполните enableCloudBot.');
}

function enableCloudBot() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const p=PropertiesService.getScriptProperties();
  if(!p.getProperty('TELEGRAM_BOT_TOKEN'))throw new Error('Сначала выполните configureCloudBot.');
  if(tgApi_('getWebhookInfo',{}).url)throw new Error('У бота настроен webhook. Сначала проверьте другое подключение.');
  tgApi_('getMe',{});
  tgApi_('setMyCommands',{commands:[['start','Главное меню'],['date','Выбрать дату'],['today','Сегодня'],['tomorrow','Завтра'],['miss','Отметить пропуск'],['clear','Убрать отметку'],['cancel','Отмена'],['subgroup','Выбрать подгруппу']].map(x=>({command:x[0],description:x[1]}))});
  p.setProperty('TG_ENABLED','false');
  ScriptApp.getProjectTriggers().filter(x=>x.getHandlerFunction()==='pollTelegram').forEach(x=>ScriptApp.deleteTrigger(x));
  if(!p.getProperty('TG_OFFSET'))p.setProperty('TG_OFFSET','0');
  ScriptApp.newTrigger('pollTelegram').timeBased().everyMinutes(1).create();
  p.setProperty('TG_ENABLED','true');
  console.log('Облачный бот включён. Проверка сообщений примерно раз в минуту.');
}

function disableCloudBot() {
  const p=PropertiesService.getScriptProperties();p.setProperty('TG_ENABLED','false');
  ScriptApp.getProjectTriggers().filter(x=>x.getHandlerFunction()==='pollTelegram').forEach(x=>ScriptApp.deleteTrigger(x));
  console.log('Облачный бот остановлен. Теперь можно запускать другую копию.');
}

function pollTelegram() {
  const p=PropertiesService.getScriptProperties();
  if(p.getProperty('TG_ENABLED')!=='true')return;
  // Separate user lock: doPost takes its own script lock for sheet writes.
  const lock=LockService.getUserLock();if(!lock.tryLock(1))return;
  try {
    const deadline=Date.now()+45000;
    const updates=tgApi_('getUpdates',{offset:Number(p.getProperty('TG_OFFSET')||0),timeout:0,limit:30,allowed_updates:['message']});
    for(const update of updates) {
      if(Date.now()>deadline)break;
      const m=update.message;
      if(m&&m.chat&&m.from&&typeof m.text==='string') {
        const key='TG_SESSION_'+m.chat.id+'_'+m.from.id;
        const state=tgReadState_(key)||{subgroup:0,pending:null};
        try {tgHandle_(m,state);}
        catch(error) {
          state.pending=null;
          try {tgSend_(m.chat.id,String(error.message||'Ошибка обработки. Проверьте таблицу и начните заново.')+'\nНачните заново: /start',TG_MAIN);}catch(sendError){console.log('Не удалось отправить ответ Telegram.');}
        }
        // Advance after an uncertain reply so the same confirmation is not retried.
        tgSaveState_(key,state);
      }
      p.setProperty('TG_OFFSET',String(update.update_id+1));
    }
    p.setProperty('TG_LAST_POLL',new Date().toISOString());
  } catch(error) {console.log('Проверка сообщений не завершена: '+String(error.message||'ошибка сервиса'));}
  finally {lock.releaseLock();}
}

function cloudBotStatus() {
  const p=PropertiesService.getScriptProperties();
  console.log(JSON.stringify({enabled:p.getProperty('TG_ENABLED')==='true',lastPoll:p.getProperty('TG_LAST_POLL'),offset:Number(p.getProperty('TG_OFFSET')||0),triggers:ScriptApp.getProjectTriggers().filter(x=>x.getHandlerFunction()==='pollTelegram').length}));
}

/** Read-only connection check: never changes attendance or consumes updates. */
function checkCloudBot() {
  ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
  const identity=tgApi_('getMe',{});
  if(identity.username!=='Schedule3112bot')throw new Error('Настроен токен другого бота.');
  const date=tgAddDay_(tgToday_(),1),snapshot=tgSnapshot_(date,true);
  const username=(PropertiesService.getScriptProperties().getProperty('ALLOWED_USERNAMES')||'').split(',')[0];
  const roster=tgSheet_('roster',username,{date});
  console.log(JSON.stringify({bot:identity.username,date,lessons:tgLessons_(snapshot,date).length,students:roster.names.length,attendanceChanged:false}));
}

/** Official Google authorization link for editors whose popup was blocked. */
function requestCloudAuthorization() {
  const info=ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
  console.log(info.getAuthorizationStatus()===ScriptApp.AuthorizationStatus.REQUIRED
    ?info.getAuthorizationUrl():'Все разрешения Google предоставлены.');
}

function tgApi_(method,payload,token) {
  token=token||PropertiesService.getScriptProperties().getProperty('TELEGRAM_BOT_TOKEN');
  if(!token)throw new Error('Токен бота не настроен.');
  let response;
  try {response=UrlFetchApp.fetch('https://api.telegram.org/bot'+token+'/'+method,{method:'post',contentType:'application/json',payload:JSON.stringify(payload),muteHttpExceptions:true});}
  catch(error){
    const detail=String(error.message||'').split(token).join('[ключ скрыт]').replace(/https?:\/\/[^\s)]+/g,'[адрес скрыт]').slice(0,300);
    throw new Error('Не удалось подключиться к Telegram. '+detail);
  }
  let result;try {result=JSON.parse(response.getContentText());}catch(error){throw new Error('Telegram вернул неверный ответ.');}
  if(!result.ok) {
    if(result.error_code===409)throw new Error('Работает другая копия бота. Остановите её перед облачным запуском.');
    if([401,404].includes(result.error_code))throw new Error('Проверьте токен бота.');
    throw new Error('Telegram временно отклонил запрос ('+Number(result.error_code||0)+').');
  }
  return result.result;
}

function tgSend_(chat,text,rows) {
  const keyboard={keyboard:(rows||TG_MAIN).map(row=>(Array.isArray(row)?row:[row]).map(x=>({text:x}))),resize_keyboard:true};
  text=String(text);
  while(text.length) {
    let end=Math.min(3000,text.length);
    if(end<text.length) {const newline=text.lastIndexOf('\n',end);if(newline>0)end=newline;else if(/[\uD800-\uDBFF]/.test(text[end-1]))end--;}
    tgApi_('sendMessage',{chat_id:chat,text:text.slice(0,end),reply_markup:keyboard,link_preview_options:{is_disabled:true}});
    text=text.slice(end).replace(/^\n/,'');
  }
}

function tgReadState_(key) {
  const p=PropertiesService.getScriptProperties(),count=Number(p.getProperty(key+'_n')||0);
  if(!count)return null;
  try {let text='';for(let i=0;i<count;i++){const part=p.getProperty(key+'_'+i);if(part===null)return null;text+=part;}return JSON.parse(text);}catch(error){return null;}
}

function tgSaveState_(key,state) {
  const p=PropertiesService.getScriptProperties(),chars=Array.from(JSON.stringify(state)),old=Number(p.getProperty(key+'_n')||0),parts={};
  const count=Math.ceil(chars.length/2000);
  for(let i=0;i<count;i++)parts[key+'_'+i]=chars.slice(i*2000,(i+1)*2000).join('');
  // Each part is at most 8 KB UTF-8; Script Properties allow 9 KB per value.
  parts[key+'_n']=String(count);p.setProperties(parts);
  for(let i=count;i<old;i++)p.deleteProperty(key+'_'+i);
}

function tgAuth_(user) {
  const p=PropertiesService.getScriptProperties(),names=(p.getProperty('ALLOWED_USERNAMES')||'').split(',').filter(Boolean),id=String(user.id);
  for(const name of names) {
    const pinned=p.getProperty('TG_ID_'+name);
    if(pinned===id)return name;
    if(!pinned&&String(user.username||'').toLowerCase()===name){p.setProperty('TG_ID_'+name,id);return name;}
  }
  return '';
}

function tgSheet_(action,username,data) {
  const payload=Object.assign({},data,{action,username,secret:PropertiesService.getScriptProperties().getProperty('SHARED_SECRET')});
  const result=JSON.parse(doPost({postData:{contents:JSON.stringify(payload)}}).getContent());
  if(!result.ok)throw new Error(result.error||'Таблица отклонила действие.');
  return result;
}

function tgToday_(){return Utilities.formatDate(new Date(),'Europe/Moscow','yyyy-MM-dd');}
function tgAddDay_(iso,offset){const date=new Date(iso+'T12:00:00Z');date.setUTCDate(date.getUTCDate()+offset);return date.toISOString().slice(0,10);}
function tgValidDate_(iso){const day=new Date(iso+'T12:00:00Z');return /^20\d\d-\d\d-\d\d$/.test(iso)&&!isNaN(day)&&day.toISOString().slice(0,10)===iso;}
function tgParseDate_(text) {
  text=String(text).replace(/^(Пн|Вт|Ср|Чт|Пт|Сб|Вс),\s*/i,'').trim();
  const relative={'сегодня':0,'завтра':1,'вчера':-1},lower=text.toLowerCase();
  if(Object.prototype.hasOwnProperty.call(relative,lower))return tgAddDay_(tgToday_(),relative[lower]);
  let iso=text,match=text.match(/^(\d\d)\.(\d\d)(?:\.(20\d\d))?$/);
  if(match)iso=(match[3]||tgToday_().slice(0,4))+'-'+match[2]+'-'+match[1];
  if(!tgValidDate_(iso))throw new Error('Напишите дату в формате ДД.ММ.ГГГГ.');
  return iso;
}
function tgDateLabel_(iso){const d=new Date(iso+'T12:00:00Z');return ['Вс','Пн','Вт','Ср','Чт','Пт','Сб'][d.getUTCDay()]+', '+iso.slice(8,10)+'.'+iso.slice(5,7)+'.'+iso.slice(0,4);}
function tgDatePicker_(chat) {const rows=[];for(let i=-7;i<7;i+=2)rows.push([tgDateLabel_(tgAddDay_(tgToday_(),i)),tgDateLabel_(tgAddDay_(tgToday_(),i+1))]);rows.push(['Отмена']);tgSend_(chat,'Выберите дату или отправьте ДД.ММ.ГГГГ.',rows);}

function tgLoadSchedule_(index,force) {
  const cache=CacheService.getScriptCache(),key='TG_SCHEDULE_'+index,cached=force?null:cache.get(key);
  if(cached)return JSON.parse(cached);
  let response;try {response=UrlFetchApp.fetch('https://polytech-shedule.ru/data/'+index+'.xml',{muteHttpExceptions:true});}catch(error){throw new Error('Не удалось подключиться к сайту расписания.');}
  if(response.getResponseCode()===404)return null;
  if(response.getResponseCode()!==200)throw new Error('Сайт расписания временно недоступен.');
  const xml=response.getContentText();
  if(xml.length>8000000||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new Error('Неподдерживаемый формат расписания.');
  let root;try {root=XmlService.parse(xml).getRootElement();}catch(error){throw new Error('Не удалось прочитать XML расписания.');}
  if(root.getName()!=='dataroot'||!root.getAttribute('generated')||!root.getChildren('My').length)throw new Error('Формат сайта расписания изменился.');
  const start=root.getAttribute('generated').getValue().slice(0,10),lessons=[],seen=new Set();let hasGroup=false;
  if(!tgValidDate_(start))throw new Error('Нет даты периода расписания.');
  for(const row of root.getChildren('My')) {
    const field=name=>String(row.getChildText(name)||'').trim();
    if(field('SPGRUP.NAIM')!==TG_GROUP)continue;
    hasGroup=true;if(field('ZAM')==='2')continue;
    const item={date:field('DAT').slice(0,10),period:Number(field('UR')),subject:field('SPPRED.NAIM'),subgroup:Number(field('IDGG')||0),teacher:field('FAMIO'),room:field('AUD'),campus:field('CAMPUS'),change:field('ZAM'),note:field('NOTE')};
    if(!tgValidDate_(item.date)||!Number.isInteger(item.period)||item.period<1||!item.subject)throw new Error('Некорректная пара в расписании.');
    const serial=JSON.stringify(item);if(!seen.has(serial)){seen.add(serial);lessons.push(item);}
  }
  lessons.sort((a,b)=>a.date.localeCompare(b.date)||a.period-b.period||a.subgroup-b.subgroup||a.subject.localeCompare(b.subject));
  const snapshot={start,lessons,hasGroup,fetched:Utilities.formatDate(new Date(),'Europe/Moscow','dd.MM HH:mm')};
  const encoded=JSON.stringify(snapshot);if(encoded.length<40000)cache.put(key,encoded,120);
  return snapshot;
}

function tgSnapshot_(date,force) {
  const day=new Date(date+'T12:00:00Z'),month=day.getUTCMonth()+1,year=day.getUTCFullYear();
  if([7,8].includes(month))throw new Error('Дата вне учебного периода. Проверьте сайт расписания.');
  const elapsed=Math.floor((day-new Date(Date.UTC(month>=9?year:year-1,8,1,12)))/86400000),index=Math.max(1,Math.min(20,Math.floor(elapsed/14)+1)),preferred=elapsed%14>=7?index+1:index;
  let lastError='';
  for(const candidate of [...new Set([preferred,index,index-1,index+1])]) {
    if(candidate<1||candidate>21)continue;
    let snapshot;try {snapshot=tgLoadSchedule_(candidate,force);}catch(error){lastError=error.message;continue;}
    if(snapshot&&snapshot.start<=date&&date<tgAddDay_(snapshot.start,14)) {
      if(!snapshot.hasGroup)throw new Error('Группа '+TG_GROUP+' не найдена в расписании этого периода.');
      return snapshot;
    }
  }
  throw new Error(lastError||'Расписание на эту дату пока не опубликовано на сайте.');
}
function tgLessons_(snapshot,date){return snapshot.lessons.filter(x=>x.date===date).map(x=>({period:x.period,subject:x.subject,subgroup:x.subgroup}));}
function tgRenderDay_(date,subgroup,force) {
  const snapshot=tgSnapshot_(date,force),lessons=snapshot.lessons.filter(x=>x.date===date&&(!subgroup||x.subgroup===0||x.subgroup===subgroup));
  const lines=[tgDateLabel_(date),'Группа '+TG_GROUP];if(subgroup)lines.push('Подгруппа '+subgroup);lines.push('');
  if(!lessons.length)lines.push('На сайте занятий на этот день нет.');
  for(const item of lessons) {
    lines.push(item.period+' пара — '+item.subject+(item.subgroup?' · подгруппа '+item.subgroup:''));
    if(item.teacher)lines.push(item.teacher);
    if(item.room)lines.push('Аудитория: '+item.room);
    if(item.campus)lines.push(({Э:'Энгельса',П:'Приморский',О:'Онлайн'})[item.campus]||item.campus);
    if(['1','3'].includes(item.change))lines.push(item.change==='1'?'Изменение в расписании':'Консультация (к)');
    if(item.note)lines.push(item.note);lines.push('');
  }
  lines.push('Проверено: '+snapshot.fetched+' МСК','https://polytech-shedule.ru');return lines.join('\n');
}

function tgHandle_(m,state) {
  const text=m.text.trim(),lower=text.toLowerCase(),parts=text.split(/\s+/),command=parts[0].split('@')[0].toLowerCase(),arg=text.slice(parts[0].length).trim(),chat=m.chat.id,auth=tgAuth_(m.from);
  if(['/start','/help'].includes(command)){state.pending=null;state.scheduleDate=false;tgSend_(chat,'Расписание и посещаемость группы '+TG_GROUP+'.\nВыберите дату и пару, затем одного или нескольких студентов и причину.\n«Убрать отметку» очищает выбранную отметку.\nОблачная версия проверяет сообщения примерно раз в минуту.',TG_MAIN);return;}
  if(command==='/cancel'||lower==='отмена'){state.pending=null;state.scheduleDate=false;tgSend_(chat,'Действие отменено.',TG_MAIN);return;}
  const free=text.match(/^(.+?)\s*[—–-]\s*(не был|не была|пропуск|больничный|заявление|объяснительная)$/i),validFree=free&&free[1].trim().split(/\s+/).length>=2;
  const startClear=command==='/clear'||lower==='убрать отметку',startMark=command==='/miss'||lower==='отметить пропуск'||validFree;
  if(startClear||startMark||state.pending) {
    if(!auth){tgSend_(chat,'Отметки доступны только участникам из списка Telegram-имён.',TG_MAIN);return;}
    if(m.chat.type!=='private'){tgSend_(chat,'Откройте личный чат с ботом для записи отметок.',TG_MAIN);return;}
    if(startClear||startMark){state.pending={stage:'date',mode:startClear?'clear':'mark',name:['/miss','/clear'].includes(command)?arg:validFree?free[1].trim():'',username:auth};tgSend_(chat,startClear?'С какой даты убрать отметку?':'На какую дату отметить пропуск?',TG_DATE);return;}
    tgAttendance_(m,state);return;
  }
  if(command==='/subgroup'||lower==='выбрать подгруппу'){tgSend_(chat,'Выберите подгруппу:',[['Вся группа'],['Подгруппа 1','Подгруппа 2'],['Назад']]);return;}
  if(['вся группа','подгруппа 1','подгруппа 2'].includes(lower)){state.subgroup=lower==='вся группа'?0:Number(lower.slice(-1));tgSend_(chat,'Выбрано: '+(state.subgroup?'подгруппа '+state.subgroup:'вся группа'),TG_MAIN);return;}
  if(lower==='назад'){tgSend_(chat,'Выберите действие:',TG_MAIN);return;}
  if((command==='/date'&&!arg)||lower==='выбрать дату'){state.scheduleDate=true;tgDatePicker_(chat);return;}
  const day=command==='/today'?'Сегодня':command==='/tomorrow'?'Завтра':command==='/date'?arg:['/refresh','обновить'].includes(lower)?'Сегодня':text;
  const date=tgParseDate_(day);state.scheduleDate=false;tgSend_(chat,tgRenderDay_(date,state.subgroup,['/refresh','обновить'].includes(lower)),TG_MAIN);
}

function tgStudents_(chat,p) {
  const names=p.filtered.slice(p.page,p.page+12),rows=[],choices={};
  const base=full=>full.split(/\s+/).slice(0,2).join(' ');
  const labels=names.map(full=>{const label=p.names.filter(x=>base(x)===base(full)).length>1?full:base(full);choices[label]=full;return p.multi&&p.selected.includes(full)?'✅ '+label:label;});
  p.studentChoices=choices;
  for(let i=0;i<labels.length;i+=2)rows.push(labels.slice(i,i+2));
  const nav=[];if(p.page>0)nav.push('← Назад');if(p.page+12<p.filtered.length)nav.push('Далее →');if(nav.length)rows.push(nav);
  if(p.mode==='mark')rows.push(p.multi?['Выбрать причину']:['Выбрать нескольких']);
  if(p.multi)rows.push(['Сбросить выбор','Выбирать по одному']);rows.push(['Весь список'],['Отмена']);
  let prompt=p.multi?'Выбрано: '+p.selected.length+'. Нажмите фамилии, затем «Выбрать причину». Повторное нажатие снимает выбор.':'Выберите студента. Можно написать часть фамилии.';
  if(p.multi&&p.selected.length)prompt+='\n'+p.selected.map(x=>'✅ '+base(x)).join('\n');tgSend_(chat,prompt,rows);
}

function tgReason_(chat,p){p.stage='reason';tgSend_(chat,p.multi?'Выбрано: '+p.selected.length+'. Укажите общую причину пропуска:':'Укажите основание пропуска:',TG_REASONS);}

function tgPrepare_(chat,p) {
  if(p.mode==='clear') {
    const data={name:p.name,date:p.date,period:p.period},r=tgSheet_('clear_prepare',p.username,data);
    if(!r.previous){tgSend_(chat,r.name+': отметки на этой паре нет, ячейка уже пустая.',TG_MAIN);return false;}
    p.prepared=Object.assign(data,{name:r.name,expected:r.expected});p.stage='confirm';
    tgSend_(chat,'Проверьте удаление:\n'+r.name+'\n'+tgDateLabel_(r.date)+', '+r.period+' пара\nПредмет: '+(r.subject||'не указан')+'\nТекущая отметка: '+r.previous+'\nЛист «'+r.sheet+'», ячейка '+r.cell+'\nБудет очищена только эта отметка.',['Подтвердить удаление','Отмена']);return true;
  }
  const snapshot=tgSnapshot_(p.date,false),lessons=tgLessons_(snapshot,p.date);
  if(!lessons.some(x=>x.period===p.period&&x.subject===p.subject&&x.subgroup===p.subgroup))throw new Error('Пары больше нет в расписании. Выберите её заново.');
  const data={date:p.date,period:p.period,mark:p.mark,attested:!!p.attested,exception:!!p.exception,subjects:[p.subject],lessons};
  if(p.multi)data.names=p.names.filter(x=>p.selected.includes(x));else data.name=p.name;
  const r=tgSheet_(p.multi?'batch_prepare':'prepare',p.username,data);
  data.expected=r.expected;if(p.multi)data.names=r.entries.map(x=>x.name);else data.name=r.name;p.prepared=data;p.stage='confirm';
  const entries=p.multi?r.entries:[r],lines=['Проверьте запись для '+entries.length+' студентов:',tgDateLabel_(r.date)+', '+r.period+' пара','Предмет: '+r.subject,'Отметка: '+r.mark,'Лист «'+r.sheet+'»'];
  for(const x of entries)lines.push('• '+x.name+' — '+x.cell+' (сейчас: '+(x.previous||'пусто')+')'+(r.mark==='З'?'; дней с З: '+x.daysWithZ+' из 3':''));
  if(r.initialize)lines.push('Будет добавлена строка дат по образцу сентября.');if(r.headers&&r.headers.length)lines.push('Предметы выбранной даты будут заполнены с сайта.');
  tgSend_(chat,lines.join('\n'),['Подтвердить запись','Отмена']);return true;
}

function tgAttendance_(m,state) {
  const text=m.text.trim(),lower=text.toLowerCase(),chat=m.chat.id,p=state.pending;
  if(p.stage==='date') {
    if(lower==='другая дата'){tgDatePicker_(chat);return;}
    p.date=tgParseDate_(text);p.choices={};
    const items=p.mode==='clear'?tgSheet_('pairs',p.username,{date:p.date}).pairs:tgSnapshot_(p.date,false).lessons.filter(x=>x.date===p.date);
    for(const x of items){const label=x.period+' пара — '+(x.subject||'предмет не указан')+(x.subgroup?' (подгр. '+x.subgroup+')':'');p.choices[label]={period:x.period,subject:x.subject,subgroup:x.subgroup||0};}
    if(!Object.keys(p.choices).length){tgSend_(chat,'На эту дату на сайте занятий нет. Выберите другую дату.',TG_DATE);return;}
    p.stage='period';tgSend_(chat,tgDateLabel_(p.date)+'\nВыберите пару:',Object.keys(p.choices).concat(['Отмена']));return;
  }
  if(p.stage==='period') {
    const choice=p.choices[text];if(!choice){tgSend_(chat,'Выберите пару кнопкой.',Object.keys(p.choices).concat(['Отмена']));return;}
    Object.assign(p,choice);
    if(p.name){if(p.mode==='clear'){if(!tgPrepare_(chat,p))state.pending=null;}else tgReason_(chat,p);return;}
    p.names=tgSheet_('roster',p.username,{date:p.date}).names;p.filtered=p.names;p.page=0;p.selected=[];p.stage='student';tgStudents_(chat,p);return;
  }
  if(p.stage==='student') {
    if(p.mode==='mark'&&['Выбрать нескольких','Выбирать по одному'].includes(text)){p.multi=text==='Выбрать нескольких';p.selected=[];tgStudents_(chat,p);return;}
    if(p.multi&&text==='Выбрать причину'){if(!p.selected.length)tgSend_(chat,'Выберите хотя бы одного студента.');else tgReason_(chat,p);return;}
    if(p.multi&&text==='Сбросить выбор'){p.selected=[];tgStudents_(chat,p);return;}
    if(text==='Весь список'){p.filtered=p.names;p.page=0;tgStudents_(chat,p);return;}
    if(['Далее →','← Назад'].includes(text)){p.page=Math.max(0,Math.min(p.page+(text==='Далее →'?12:-12),Math.floor((p.filtered.length-1)/12)*12));tgStudents_(chat,p);return;}
    const full=p.studentChoices[text.replace(/^✅\s*/,'')];
    if(full) {
      if(p.multi){if(p.selected.includes(full))p.selected=p.selected.filter(x=>x!==full);else p.selected.push(full);tgStudents_(chat,p);return;}
      p.name=full;if(p.mode==='clear'){if(!tgPrepare_(chat,p))state.pending=null;}else tgReason_(chat,p);return;
    }
    const filtered=p.names.filter(x=>normalize_(x).includes(normalize_(text)));
    if(!filtered.length){tgSend_(chat,'Студент не найден. Выберите фамилию кнопкой.');return;}
    p.filtered=filtered;p.page=0;tgStudents_(chat,p);return;
  }
  if(p.stage==='reason') {
    const mark=({'Н — без уважительной причины':'Н','Б — справка':'Б','З — заявление':'З','О — объяснительная':'О'})[text];
    if(!mark){tgSend_(chat,'Выберите причину кнопкой.',TG_REASONS);return;}p.mark=mark;
    if(mark==='Б'||mark==='З') {
      p.stage='evidence';const all=p.multi?'Для каждого выбранного студента: ':'Подтвердите: ';
      tgSend_(chat,all+(mark==='Б'?'справка проверена и есть в чате группы по шаблону. Бот не проверяет документы самостоятельно.':'заявление есть в чате, на нём есть подпись Назарова. Лимит — три разных дня в месяц.'),[mark==='Б'?'Справка проверена и есть в чате':'Заявление в чате, подпись есть','Отмена']);return;
    }
    if(mark==='О'){p.stage='exception';tgSend_(chat,'Объяснительная отмечается как Н. З допустима только по согласованию с куратором'+(p.multi?' для каждого выбранного студента.':'.'),['Записать Н','Куратор согласовал З','Отмена']);return;}
    tgPrepare_(chat,p);return;
  }
  if(p.stage==='evidence') {
    const expected=p.mark==='Б'?'Справка проверена и есть в чате':'Заявление в чате, подпись есть';
    if(text!==expected){tgSend_(chat,'Требуется подтверждение ответственным.',[expected,'Отмена']);return;}p.attested=true;tgPrepare_(chat,p);return;
  }
  if(p.stage==='exception') {
    if(!['Записать Н','Куратор согласовал З'].includes(text)){tgSend_(chat,'Выберите вариант кнопкой.',['Записать Н','Куратор согласовал З','Отмена']);return;}
    p.mark=text==='Записать Н'?'Н':'З';p.exception=p.mark==='З';p.attested=p.exception;tgPrepare_(chat,p);return;
  }
  if(p.stage==='confirm') {
    const expected=p.mode==='clear'?'Подтвердить удаление':'Подтвердить запись';
    if(text!==expected){tgSend_(chat,'Нажмите «'+expected+'» или «Отмена».',[expected,'Отмена']);return;}
    if(p.mode==='clear'){const r=tgSheet_('clear_commit',p.username,p.prepared);state.pending=null;tgSend_(chat,'Отметка удалена: '+r.name+'\n'+tgDateLabel_(r.date)+', '+r.period+' пара\nЛист «'+r.sheet+'», ячейка '+r.cell,TG_MAIN);return;}
    const fresh=tgLessons_(tgSnapshot_(p.date,true),p.date);
    if(JSON.stringify(fresh)!==JSON.stringify(p.prepared.lessons))throw new Error('Расписание изменилось после просмотра. Выберите пару заново.');
    const r=tgSheet_(p.multi?'batch_commit':'commit',p.username,p.prepared);state.pending=null;
    const entries=p.multi?r.entries:[r];tgSend_(chat,'Записано: '+entries.length+' студентов\n'+tgDateLabel_(r.date)+', '+r.period+' пара\nПредмет: '+r.subject+'\nОтметка: '+r.mark+'\nЛист «'+r.sheet+'»\n'+entries.map(x=>'• '+x.name+' — '+x.cell).join('\n'),TG_MAIN);return;
  }
  throw new Error('Начните действие заново.');
}
