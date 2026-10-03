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
