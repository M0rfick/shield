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
