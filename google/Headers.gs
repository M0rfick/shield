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
