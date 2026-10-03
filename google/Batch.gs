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
