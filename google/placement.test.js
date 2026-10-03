// In-memory Sheets model: verifies date/pair/student placement without real writes.
const fs=require('fs'),vm=require('vm'),assert=require('assert'),crypto=require('crypto'),path=require('path');
const context={Date,Set,Utilities:{formatDate:d=>d.toISOString().slice(0,10),parseDate:s=>new Date(s+'T12:00:00Z')}};
vm.createContext(context);
for(const file of ['Attendance.gs','Headers.gs','Clear.gs','Batch.gs'])vm.runInContext(fs.readFileSync(path.join(__dirname,file),'utf8'),context);
context.digest_=s=>crypto.createHash('sha256').update(s).digest('hex');
class Sheet {
 constructor(name,header=3){this.name=name;this.rows=Array.from({length:8},()=>Array(132).fill(''));this.writes=[];this.header=header;
  this.rows[header-1][1]='ФИО';this.rows[header][0]=1;this.rows[header][1]='Иванов Иван Иванович';
  this.rows[header+1][0]=2;this.rows[header+1][1]='Петров Пётр Петрович';
 }
 getRange(r,c,h=1,w=1){if(typeof r==='string'){const a=r.match(/^([A-Z]+)(\d+)$/);c=Array.from(a[1]).reduce((n,x)=>n*26+x.charCodeAt(0)-64,0);r=Number(a[2]);}return new Range(this,r,c,h,w)}
 getRangeList(addresses){return {setValue:value=>addresses.forEach(a=>this.getRange(a).setValue(value))}}
 getLastRow(){return this.rows.length}getLastColumn(){return 132}getMaxColumns(){return 166}
 getSheetId(){return this.name==='октябрь'?1:2}getName(){return this.name}getParent(){return this.book}
 getRowHeight(){return 30}setRowHeight(){}insertRowsBefore(r){this.rows.splice(r-1,0,Array(132).fill(''))}
}
class Range {
 constructor(s,r,c,h,w){Object.assign(this,{s,r,c,h,w})}
 getValues(){return Array.from({length:this.h},(_,i)=>Array.from({length:this.w},(_,j)=>this.s.rows[this.r+i-1]?.[this.c+j-1]??''))}
 getDisplayValues(){return this.getValues().map(row=>row.map(x=>x instanceof Date?x.toISOString().slice(0,10):String(x)))}
 getFormulas(){return Array.from({length:this.h},()=>Array(this.w).fill(''))}
 getDisplayValue(){return this.getDisplayValues()[0][0]}getValue(){return this.getValues()[0][0]}
 getFormula(){return this.s.formulas?.[this.getA1Notation()]||''}canEdit(){return true}isPartOfMerge(){return false}getDataValidation(){return null}
 getA1Notation(){let c=this.c,s='';while(c){c--;s=String.fromCharCode(65+c%26)+s;c=Math.floor(c/26)}return s+this.r}
 setValue(value){this.s.rows[this.r-1][this.c-1]=value;this.s.writes.push([this.r,this.c,value]);return this}
 clearContent(){return this.setValue('')}
 merge(){return this}copyTo(){}setNumberFormat(){return this}
}
const october=new Sheet('октябрь'),november=new Sheet('ноябрь',2),template=new Sheet('сентябрь');
october.rows[1][2]=new Date('2026-10-01T12:00:00Z');october.rows[1][7]=new Date('2026-10-02T12:00:00Z');
october.rows[2][7]='История';october.rows[3][8]='Н';october.rows[4][2]='Б';
const book={getSheetByName:n=>({'октябрь':october,'ноябрь':november,'сентябрь':template})[n],getSpreadsheetTimeZone:()=> 'Europe/Moscow'};
for(const sheet of [october,november,template])sheet.book=book;
context.SpreadsheetApp={openById:()=>book,flush:()=>{}};
context.PropertiesService={getScriptProperties:()=>({getProperty:key=>({SHARED_SECRET:'secret',ALLOWED_USERNAMES:'shcherbakov_23',SPREADSHEET_ID:'book'})[key]})};
context.LockService={getScriptLock:()=>({tryLock:()=>true,hasLock:()=>false})};
context.ContentService={MimeType:{JSON:'json'},createTextOutput:text=>({setMimeType:()=>JSON.parse(text)})};
const post=data=>context.doPost({postData:{contents:JSON.stringify({...data,secret:'secret',username:'Shcherbakov_23'})}});
const request={date:'2026-10-02',period:2,name:'Петров Пётр Петрович',mark:'Н',attested:false,subjects:['ОАП'],lessons:[{period:2,subject:'ОАП',subgroup:0}]};
const preview=post({...request,action:'prepare'});assert(preview.ok,preview.error);assert.equal(preview.cell,'I5');
assert.equal(october.writes.length,0,'preview must not write');
const saved=post({...request,action:'commit',expected:preview.expected});assert(saved.ok,saved.error);
assert.equal(october.rows[4][8],'Н');assert.equal(october.rows[2][8],'ОАП');
assert.equal(october.rows[3][8],'Н','another student remains unchanged');assert.equal(october.rows[4][2],'Б','another date remains unchanged');
const nov={...request,date:'2026-11-02',period:4,name:'Иванов Иван Иванович',lessons:[{period:4,subject:'ОАП',subgroup:0}]};
const next=post({...nov,action:'prepare'});assert(next.ok,next.error);assert.equal(next.cell,'F4');assert(next.initialize);
assert.equal(november.rows[2][1],'Иванов Иван Иванович','preview does not move names');
const ready=post({...nov,action:'commit',expected:next.expected});assert(ready.ok,ready.error);
assert.equal(november.rows[3][1],'Иванов Иван Иванович');assert.equal(november.rows[4][1],'Петров Пётр Петрович');
assert.equal(november.rows[1][2].toISOString().slice(0,10),'2026-11-02');assert.equal(november.rows[2][5],'ОАП');assert.equal(november.rows[3][5],'Н');
const last=context.headersPlan_(book,{...nov,date:'2026-11-30'});assert.equal(last.start,123,'last November Monday uses its own block');
const stale=post({...request,action:'prepare'});october.rows[4][8]='Б';
assert.match(post({...request,action:'commit',expected:stale.expected}).error,/изменились/);
console.log('Placement checks passed: October I5, November F4, month dates, roster preservation, stale confirmation.');
const pairs=post({action:'pairs',date:request.date});assert(pairs.ok,pairs.error);assert.equal(pairs.pairs.length,5);assert.equal(pairs.pairs[1].subject,'ОАП');
const removal={date:request.date,period:2,name:request.name};
const before=october.writes.length;
const clear=post({...removal,action:'clear_prepare'});assert(clear.ok,clear.error);assert.equal(clear.previous,'Б');assert.equal(clear.cell,'I5');assert.equal(october.writes.length,before);
october.rows[4][8]='н';
assert.match(post({...removal,action:'clear_commit',expected:clear.expected}).error,/изменились/);assert.equal(october.rows[4][8],'н');
const current=post({...removal,action:'clear_prepare'});
const cleared=post({...removal,action:'clear_commit',expected:current.expected});assert(cleared.ok,cleared.error);
assert.equal(october.writes.length,before+1);assert.equal(october.rows[4][8],'');assert.equal(october.rows[2][8],'ОАП');assert.equal(october.rows[3][8],'Н');assert.equal(october.rows[4][2],'Б');
assert(post({...removal,action:'clear_commit',expected:current.expected}).unchanged);assert.equal(october.writes.length,before+1);
october.rows[4][8]='Другая запись';assert.match(post({...removal,action:'clear_prepare'}).error,/другая запись/);
october.rows[4][8]='Н';october.formulas={I5:'=1'};assert.match(post({...removal,action:'clear_prepare'}).error,/формула/);delete october.formulas;
october.rows[4][7]='з';october.rows[4][8]='З';
const z=post({...removal,action:'clear_prepare'});assert(post({...removal,action:'clear_commit',expected:z.expected}).ok);
const dateBlocks=context.dateBlocks_(october.rows[1],'Europe/Moscow');assert.equal(context.countDaysWithZ_(october.rows[4],dateBlocks,request.date,'Н'),1);
const zlast=post({...removal,period:1,action:'clear_prepare'});assert(post({...removal,period:1,action:'clear_commit',expected:zlast.expected}).ok);
assert.equal(context.countDaysWithZ_(october.rows[4],dateBlocks,request.date,'Н'),0);
console.log('Clear checks passed: exact cell, lowercase marks, unchanged headers, stale confirmation, empty cell, formulas, Z day counts.');

// Multi-student writes: all checks precede the shared write.
const batch={...request,names:['Иванов Иван Иванович','Петров Пётр Петрович']};delete batch.name;
const batchBefore=october.writes.length;
const batchPreview=post({...batch,action:'batch_prepare'});assert(batchPreview.ok,batchPreview.error);
assert.deepEqual(batchPreview.entries.map(x=>x.cell),['I4','I5']);assert.equal(october.writes.length,batchBefore);
october.formulas={I5:'=1'};
assert.match(post({...batch,action:'batch_commit',expected:batchPreview.expected}).error,/Петров.*формула/);
assert.equal(october.writes.length,batchBefore,'a failing second student must prevent all writes');delete october.formulas;
const batchSaved=post({...batch,action:'batch_commit',expected:batchPreview.expected});assert(batchSaved.ok,batchSaved.error);
assert.equal(october.rows[3][8],'Н');assert.equal(october.rows[4][8],'Н');assert.equal(october.rows[4][2],'Б');
const staleBatch=post({...batch,action:'batch_prepare'});october.rows[4][8]='Б';const writesBeforeStale=october.writes.length;
assert.match(post({...batch,action:'batch_commit',expected:staleBatch.expected}).error,/изменилась/);
assert.equal(october.writes.length,writesBeforeStale);assert.equal(october.rows[4][8],'Б');
assert.match(post({...batch,names:['Иванов Иван','Иванов Иван Иванович'],action:'batch_prepare'}).error,/одному студенту/);
october.rows[1][12]=new Date('2026-10-05T12:00:00Z');october.rows[1][17]=new Date('2026-10-06T12:00:00Z');
october.rows[4][2]='З';october.rows[4][12]='з';october.rows[4][17]='З';
const zFailure=post({...batch,mark:'З',attested:true,action:'batch_prepare'});
assert.match(zFailure.error,/Петров.*Лимит З/);assert.equal(october.writes.length,writesBeforeStale);
const december=new Sheet('декабрь',2);december.book=book;
december.rows.forEach(row=>row.push(...Array(5).fill('')));december.getLastColumn=()=>137;
const oldLookup=book.getSheetByName;book.getSheetByName=n=>n==='декабрь'?december:oldLookup(n);
const firstBatch={...batch,date:'2026-12-01'};
const firstPreview=post({...firstBatch,action:'batch_prepare'});assert(firstPreview.ok,firstPreview.error);assert(firstPreview.initialize);
assert.equal(december.writes.length,0);assert.deepEqual(firstPreview.entries.map(x=>x.cell),['D4','D5']);
const firstSaved=post({...firstBatch,action:'batch_commit',expected:firstPreview.expected});assert(firstSaved.ok,firstSaved.error);
assert.equal(december.rows[3][3],'Н');assert.equal(december.rows[4][3],'Н');assert.equal(december.rows[2][3],'ОАП');
assert.equal(december.rows[3][1],'Иванов Иван Иванович');assert.equal(december.rows[4][1],'Петров Пётр Петрович');
console.log('Batch checks passed: exact rows, all-student validation, stale preview, duplicate identities, individual Z limits, month initialization.');
