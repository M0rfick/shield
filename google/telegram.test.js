// Cloud runtime contract tests. No Telegram messages or real sheet writes.
const fs=require('fs'),vm=require('vm'),assert=require('assert'),path=require('path');
const values={},sent=[],sheetCalls=[];
const props={getProperty:k=>values[k]??null,setProperty:(k,v)=>{assert(Buffer.byteLength(v)<9000);values[k]=v;},setProperties:o=>{for(const[k,v]of Object.entries(o))props.setProperty(k,v);},deleteProperty:k=>delete values[k]};
const ctx={Date,Set,console,PropertiesService:{getScriptProperties:()=>props},Utilities:{formatDate:d=>d.toISOString().slice(0,10)},normalize_:v=>String(v||'').toLowerCase().replace(/ё/g,'е').replace(/\s+/g,' ').trim()};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(__dirname,'Telegram.gs'),'utf8'),ctx);
const snapshotFn=ctx.tgSnapshot_;
const weekSendFn=ctx.tgSendWeek_;
ctx.tgToday_=()=> '2026-10-04';
ctx.tgSend_=(chat,text,rows)=>sent.push({chat,text,rows});
const lesson={date:'2026-10-05',period:1,subject:'ОАП',subgroup:0};
ctx.tgSnapshot_=()=>({start:'2026-10-05',hasGroup:true,lessons:[lesson]});
ctx.tgSheet_=(action,username,data)=>{
 sheetCalls.push({action,username,data});
 if(action==='roster')return {names:['Иванов Иван Иванович','Петров Пётр Петрович']};
 if(action==='pairs')return {pairs:[{period:1,subject:'ОАП'}]};
 return {...data,name:data.name||'Иванов Иван Иванович',sheet:'октябрь',cell:'R4',subject:'ОАП',previous:'Н',expected:'hash',daysWithZ:1,
  entries:(data.names||[]).map((name,i)=>({name,cell:'R'+(i+4),previous:'',daysWithZ:i+1}))};
};
values.ALLOWED_USERNAMES='allowed';
function newState(){return {subgroup:0,pending:null};}
function message(state,text,id=42,username='allowed'){ctx.tgHandle_({text,chat:{id:1,type:'private'},from:{id,username}},state);}
function begin(state,multi=false){message(state,'/miss');message(state,'Завтра');message(state,'1 пара — ОАП');if(multi)message(state,'Выбрать нескольких');}
let state=newState();begin(state,true);
message(state,'Иванов Иван');message(state,'Петров Пётр');assert.equal(state.pending.selected.length,2);
message(state,'✅ Иванов Иван');assert.equal(state.pending.selected.length,1);message(state,'Иванов Иван');
message(state,'Выбрать причину');message(state,'Н — без уважительной причины');
assert.equal(sheetCalls.at(-1).action,'batch_prepare');assert.equal(sheetCalls.at(-1).data.names.length,2);
assert(!sheetCalls.some(x=>x.action==='batch_commit'));
message(state,'Подтвердить запись');assert.equal(sheetCalls.at(-1).action,'batch_commit');assert.equal(state.pending,null);
state=newState();begin(state);message(state,'Петров Пётр');message(state,'Н — без уважительной причины');assert.equal(sheetCalls.at(-1).action,'prepare');message(state,'Отмена');assert.equal(state.pending,null);
state=newState();begin(state,true);message(state,'Иванов Иван');message(state,'Петров Пётр');message(state,'Выбрать причину');message(state,'Б — справка');
assert(sent.at(-1).text.includes('каждого'));assert.equal(state.pending.stage,'evidence');message(state,'Справка проверена и есть в чате');assert(sheetCalls.at(-1).data.attested);message(state,'Отмена');
state=newState();begin(state);message(state,'Иванов Иван');message(state,'О — объяснительная');message(state,'Записать Н');assert.equal(sheetCalls.at(-1).data.mark,'Н');message(state,'Отмена');
state=newState();begin(state);message(state,'Иванов Иван');message(state,'О — объяснительная');message(state,'Куратор согласовал З');assert.equal(sheetCalls.at(-1).data.mark,'З');assert(sheetCalls.at(-1).data.exception);message(state,'Отмена');
state=newState();message(state,'/clear');message(state,'Завтра');message(state,'1 пара — ОАП');message(state,'Иванов Иван');assert.equal(sheetCalls.at(-1).action,'clear_prepare');
message(state,'Подтвердить запись');assert.equal(sheetCalls.at(-1).action,'clear_prepare');message(state,'Подтвердить удаление');assert.equal(sheetCalls.at(-1).action,'clear_commit');
assert.equal(ctx.tgAuth_({id:42,username:'newname'}),'allowed');assert.equal(ctx.tgAuth_({id:77,username:'allowed'}),'');
// One weekly reply includes Monday through Sunday and respects subgroup selection.
ctx.tgSendWeek_=(chat,text,start)=>sent.push({chat,text,start});
state=newState();state.subgroup=1;const weekBefore=sent.length;message(state,'/week 05.10.2026');
assert.equal(sent.length,weekBefore+1);assert.equal(sent.at(-1).start,'2026-10-05');
assert(sent.at(-1).text.includes('Пн, 05.10.2026'));assert(sent.at(-1).text.includes('Вс, 11.10.2026'));assert(sent.at(-1).text.includes('ОАП'));
ctx.tgSnapshot_=()=>({start:'2026-10-05',lessons:[lesson,{...lesson,subject:'Other subgroup',subgroup:2}]});
message(state,'/week 08.10.2026');assert(!sent.at(-1).text.includes('Other subgroup'));
assert.equal(ctx.tgWeekStart_('2027-01-02'),'2026-12-28');
ctx.tgSnapshot_=()=>{throw new Error('Расписание не опубликовано.');};
assert(ctx.tgRenderWeek_('2026-10-05',0).includes('не опубликовано'));assert(!ctx.tgRenderWeek_('2026-10-05',0).includes('Занятий нет.'));
ctx.tgSnapshot_=()=>({start:'2026-10-05',hasGroup:true,lessons:[lesson]});
let weekApi=[];ctx.tgApi_=(method,payload)=>weekApi.push({method,payload});
ctx.Utilities.newBlob=(text,type,name)=>({text,type,name});
weekSendFn(1,'а'.repeat(4096),'2026-10-05');assert.equal(weekApi.length,1);assert.equal(weekApi[0].method,'sendMessage');
const longWeek='😀'.repeat(2049);weekSendFn(1,longWeek,'2026-10-05');assert.equal(weekApi.length,2);assert.equal(weekApi[1].method,'sendDocument');assert.equal(weekApi[1].payload.document.text,longWeek);
ctx.updateBotCommands();assert(weekApi.at(-1).payload.commands.some(x=>x.command==='week'));
state=newState();const callsBefore=sheetCalls.length;message(state,'/miss',77,'allowed');assert.equal(sheetCalls.length,callsBefore);assert.equal(state.pending,null);
const large={pending:{selected:Array.from({length:40},(_,i)=>'Студент'+i+' '+('Фамилия 😀'.repeat(30)))},subgroup:2};
ctx.tgSaveState_('state',large);assert(Number(values.state_n)>1);assert.equal(JSON.stringify(ctx.tgReadState_('state')),JSON.stringify(large));ctx.tgSaveState_('state',{pending:null});assert.equal(values.state_n,'1');assert(!values.state_1);
ctx.tgToday_=()=> '2026-12-31';assert.equal(ctx.tgParseDate_('Завтра'),'2027-01-01');assert.equal(ctx.tgParseDate_('Вчера'),'2026-12-30');assert.equal(ctx.tgParseDate_('Пн, 05.10.2026'),'2026-10-05');assert.throws(()=>ctx.tgParseDate_('31.02.2026'));
// Polling saves conversations and advances offset, including a failed final reply.
ctx.LockService={getUserLock:()=>({tryLock:()=>true,releaseLock:()=>{}})};
let apiCalls=0;values.TG_ENABLED='false';ctx.tgApi_=()=>{apiCalls++;throw new Error('disabled polling must not connect');};ctx.pollTelegram();assert.equal(apiCalls,0);
values.TG_ENABLED='true';let processed=0;
ctx.tgApi_=(method,payload)=>{assert.equal(method,'getUpdates');assert.equal(payload.timeout,0);return payload.offset>=12?[]:[{update_id:11,message:{text:'hello',chat:{id:1,type:'private'},from:{id:42,username:'allowed'}}}];};
ctx.tgHandle_=(m,s)=>{processed++;s.pending=null;throw new Error('Reply failed after confirmation');};ctx.pollTelegram();assert.equal(values.TG_OFFSET,'12');ctx.pollTelegram();assert.equal(processed,1);assert.equal(ctx.tgReadState_('TG_SESSION_1_42').pending,null);
// The direct receiver requires a secret path and never replays a confirmation.
ctx.HtmlService={createHtmlOutput:text=>({getContent:()=>text})};
ctx.tgWebhookKey_=()=> 'private-path';ctx.constantEqual_=(a,b)=>a===b;
values.TG_MODE='webhook';values.TG_OFFSET='12';
const event={pathInfo:'telegram/private-path',postData:{contents:JSON.stringify({update_id:12,message:{text:'confirm',chat:{id:1,type:'private'},from:{id:42}}})}};
let directHandled=0;ctx.tgHandle_=()=>{directHandled++;};
ctx.tgWebhook_({...event,pathInfo:'telegram/wrong'});assert.equal(directHandled,0);
ctx.tgWebhook_(event);ctx.tgWebhook_(event);assert.equal(directHandled,1);assert.equal(values.TG_OFFSET,'13');
ctx.tgWebhook_({...event,postData:{contents:'invalid'}});assert.equal(directHandled,1);
values.TG_MODE='polling';ctx.tgWebhook_({...event,postData:{contents:JSON.stringify({update_id:13})}});assert.equal(values.TG_OFFSET,'13');
values.TG_MODE='webhook';ctx.LockService.getUserLock=()=>({tryLock:()=>false});assert.throws(()=>ctx.tgWebhook_(event),/предыдущее сообщение/);
ctx.LockService.getUserLock=()=>({tryLock:()=>true,releaseLock:()=>{}});
// Transport must return HTTP 200 without a redirect before enabling Telegram.
values.TG_WEB_APP_URL='https://script.google.com/macros/s/test/exec';
ctx.UrlFetchApp={fetch:(url,opts)=>{assert.equal(opts.followRedirects,false);return {getResponseCode:()=>302};}};
assert.throws(()=>ctx.checkWebhookTransport(),/перенаправление/);
ctx.UrlFetchApp.fetch=()=>({getResponseCode:()=>200});ctx.checkWebhookTransport();
// A dated old-year file must never cover a new-year request.
ctx.tgSnapshot_=snapshotFn;
ctx.tgLoadSchedule_=()=>({start:'2025-10-01',lessons:[],hasGroup:true});assert.throws(()=>ctx.tgSnapshot_('2026-10-05'),/не опубликовано/);
ctx.tgLoadSchedule_=()=>({start:'2026-10-05',lessons:[],hasGroup:false});assert.throws(()=>ctx.tgSnapshot_('2026-10-05'),/не найдена/);
// Site schema, cancellation, duplicate rows and cache use.
const siteCtx={Date,Set,console,PropertiesService:{getScriptProperties:()=>props},Utilities:{formatDate:()=> '04.10 12:00'}};
vm.createContext(siteCtx);vm.runInContext(fs.readFileSync(path.join(__dirname,'Telegram.gs'),'utf8'),siteCtx);
const apiFn=siteCtx.tgApi_;
const dataRow={'SPGRUP.NAIM':'26290911/3112',DAT:'2026-10-05T00:00:00',UR:'1','SPPRED.NAIM':'ОАП',IDGG:'0',ZAM:'0',AUD:'305'};
const sourceRows=[dataRow,dataRow,{...dataRow,ZAM:'2'},{...dataRow,'SPGRUP.NAIM':'other'},{...dataRow,UR:'2',IDGG:'1'}];
siteCtx.XmlService={parse:()=>({getRootElement:()=>({getName:()=> 'dataroot',getAttribute:()=>({getValue:()=> '2026-09-28T12:07:45'}),getChildren:()=>sourceRows.map(row=>({getChildText:k=>row[k]}))})})};
let fetched=0,cachedValue=null;
siteCtx.UrlFetchApp={fetch:()=>{fetched++;return {getResponseCode:()=>200,getContentText:()=>'<dataroot/>'};}};
siteCtx.CacheService={getScriptCache:()=>({get:()=>cachedValue,put:(k,v)=>{cachedValue=v;}})};
const snapshot=siteCtx.tgLoadSchedule_(3,false);assert.equal(snapshot.lessons.length,2);assert.equal(snapshot.lessons[1].subgroup,1);assert(snapshot.hasGroup);
siteCtx.tgLoadSchedule_(3,false);assert.equal(fetched,1);siteCtx.tgLoadSchedule_(3,true);assert.equal(fetched,2);
siteCtx.UrlFetchApp.fetch=()=>({getResponseCode:()=>200,getContentText:()=> '<!DOCTYPE x><x/>'});assert.throws(()=>siteCtx.tgLoadSchedule_(3,true),/Неподдерживаемый/);
// Failed trigger creation never advertises an enabled cloud runtime.
values.TELEGRAM_BOT_TOKEN='test-only';values.TG_ENABLED='false';
siteCtx.tgApi_=()=>({});siteCtx.ScriptApp={requireAllScopes:()=>{},AuthMode:{FULL:'FULL'},getProjectTriggers:()=>[],newTrigger:()=>({timeBased:()=>({everyMinutes:()=>({create:()=>{throw new Error('Trigger rejected');}})})})};
assert.throws(()=>siteCtx.enableCloudBot(),/Trigger rejected/);assert.equal(values.TG_ENABLED,'false');
// Receiver adapter consumes ContentService TextOutput and surfaces errors.
siteCtx.doPost=e=>({getContent:()=>{const request=JSON.parse(e.postData.contents);assert.equal(request.action,'roster');return JSON.stringify({ok:true,names:['Test']});}});
assert.equal(siteCtx.tgSheet_('roster','allowed',{date:'2026-10-05'}).names[0],'Test');
siteCtx.doPost=()=>({getContent:()=>JSON.stringify({ok:false,error:'Limit rejected'})});assert.throws(()=>siteCtx.tgSheet_('roster','allowed',{}),/Limit rejected/);
siteCtx.UrlFetchApp.fetch=()=>{throw new Error('Required script.external_request https://api.telegram.org/botprivate-test-token/getMe private-test-token');};
assert.throws(()=>apiFn('getMe',{},'private-test-token'),e=>e.message.includes('script.external_request')&&!e.message.includes('private-test-token')&&!e.message.includes('https://'));
console.log('Cloud checks passed: multi/single marks, clearing, evidence, date rollover, large Unicode sessions, identities, polling offsets, stale years.');
