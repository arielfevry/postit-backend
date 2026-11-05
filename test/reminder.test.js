const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { validateReminder } = require('../lib/reminderValidation');
const { createEmailService } = require('../services/emailService');
const { createSmsService } = require('../services/smsService');
const { createReminderWorker, workerConfig } = require('../workers/reminderWorker');
const valid = {itemId:'123456789012345678901234',channel:'email',recipient:'test@example.com',remindAt:'2099-01-01T00:00:00Z',message:'Test'};
function load(relative, dependencies, env = {}) {
  const module = {exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',relative),'utf8'), {
    module, exports:module.exports, require(name) {
      if (name in dependencies) return dependencies[name];
      throw Error('Unexpected dependency: '+name);
    }, console:{log(){},error(){}}, process:{env:{PORT:'5000',...env}}
  });
  return module.exports;
}
function response() {return {code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}
test('validation covers IDs, dates, recipients, body types, message and protected fields',()=>{
  assert.ok(validateReminder(valid).value);
  for(const patch of [{itemId:'bad'},{channel:'fax'},{recipient:'bad'},{remindAt:'2020-01-01T00:00:00Z'},{remindAt:'2099-02-30T00:00:00Z'},{remindAt:'2099-01-01T00:00:00'},{remindAt:12},{message:''},{message:'a'.repeat(1601)}, {status:'sent'},{sentAt:'2099'},{userId:valid.itemId},{deliveryAuthorized:true},{deliveryMode:'live'},{channel:'sms',recipient:'5551234567'}]) assert.ok(validateReminder({...valid,...patch}).error,JSON.stringify(patch));
  for(const body of [null,[],undefined,'text']) assert.ok(validateReminder(body).error);
  assert.ok(validateReminder({...valid,channel:'sms',recipient:'+12125551234'}).value);
});
test('authorized POST retains success shape and records server authorization; invalid/missing items handled',async()=>{
  let saved;
  const controller=load('controllers/reminderController.js',{
    '../models/Reminder':{async create(value){saved=value;return {...value,status:'pending'};}},
    '../models/Item':{async findOne(query){return query._id===valid.itemId && query.userId==='aaaaaaaaaaaaaaaaaaaaaaaa'?{}:null;}},
    '../lib/reminderValidation':{validateReminder}
  });
  let res=response();await controller.createReminder({body:valid,user:{id:'aaaaaaaaaaaaaaaaaaaaaaaa'}},res);assert.equal(res.code,201);assert.equal(saved.userId,'aaaaaaaaaaaaaaaaaaaaaaaa');assert.equal(res.body.reminder.deliveryAuthorized,true);
  res=response();await controller.createReminder({user:{id:'aaaaaaaaaaaaaaaaaaaaaaaa'},body:{...valid,deliveryAuthorized:true}},res);assert.equal(res.code,400);
  res=response();await controller.createReminder({user:{id:'aaaaaaaaaaaaaaaaaaaaaaaa'},body:{...valid,itemId:'aaaaaaaaaaaaaaaaaaaaaaaa'}},res);assert.equal(res.code,404);
});
test('provider services mock SDKs, reject failures, and make no network requests',async()=>{
  let data;
  const env={SENDGRID_API_KEY:'fake',SENDGRID_FROM_EMAIL:'sender@example.com'};
  const client={setApiKey(){},setTimeout(){},async send(value){data=value;return [{statusCode:202,headers:{'x-message-id':'accepted'}}];}};
  assert.equal(await createEmailService({env,client})(valid),'accepted');assert.equal(data.to,valid.recipient);
  client.send=async()=>[{statusCode:400}];await assert.rejects(createEmailService({env,client})(valid));
  await assert.rejects(createEmailService({env:{}})(valid));
  const smsEnv={TWILIO_ACCOUNT_SID:'fake',TWILIO_AUTH_TOKEN:'fake',TWILIO_FROM_PHONE:'+12125551234'};
  const smsClient={messages:{async create(){return {sid:'fake-id',status:'queued'};}}};
  assert.equal(await createSmsService({env:smsEnv,client:smsClient})(valid),'fake-id');
  smsClient.messages.create=async()=>({sid:'id',status:'failed'});await assert.rejects(createSmsService({env:smsEnv,client:smsClient})(valid));
  await assert.rejects(createSmsService({env:{...smsEnv,TWILIO_FROM_PHONE:'bad'},client:smsClient})(valid));
});
// Query-aware in-memory Mongo substitute. Actual Mongo atomicity is an integration concern.
function matches(row,query) {
  return Object.entries(query).every(([key,value])=>{
    if(key==='$and')return value.every(q=>matches(row,q));
    if(key==='$or')return value.some(q=>matches(row,q));
    const actual=row[key];
    if(value && typeof value==='object' && !(value instanceof Date))return Object.entries(value).every(([op,b])=>{
      if(op==='$lt')return actual<b;if(op==='$lte')return actual!=null && actual<=b;
      if(op==='$gt')return actual>b;if(op==='$gte')return actual>=b;
      if(op==='$ne')return b===null?actual!=null:actual!==b;
      if(op==='$exists')return (actual!==undefined)===b;
      throw Error(op);
    });
    return value===null?actual==null:actual===value;
  });
}
function apply(row,update){Object.assign(row,update.$set);for(const [k,v] of Object.entries(update.$inc||{}))row[k]=(row[k]||0)+v;}
function fixture(overrides={}) {
  let time=new Date('2030-01-01T00:00:00Z');let sends=0;let fail=false;let item=true;let writeFailure=false;
  const row={...valid,_id:'r',userId:'aaaaaaaaaaaaaaaaaaaaaaaa',remindAt:new Date('2029-01-01'),status:'pending',attempts:0,deliveryAuthorized:true,...overrides};
  const Reminder={
    async updateMany(q,u){if(matches(row,q))apply(row,u);},
    async findOneAndUpdate(q,u){if(!matches(row,q))return null;apply(row,u);return structuredClone(row);},
    async updateOne(q,u){if(writeFailure && u.$set.status==='sent')throw Error('database unavailable');if(!matches(row,q))return {matchedCount:0};apply(row,u);return {matchedCount:1};}
  };
  const deps={Reminder,Item:{async exists(q){assert.equal(q.userId,row.userId);return item;}},now:()=>time,config:workerConfig({REMINDER_DELIVERY_MODE:'live'}),async sendEmail(){sends++;if(fail)throw Error('secret recipient');return 'accepted';},async sendSms(){sends++;return 'sms-id';}};
  return {row,deps,worker:createReminderWorker(deps),get sends(){return sends;},advance(ms){time=new Date(+time+ms);},fail(){fail=true;},missing(){item=false;},writeFailure(){writeFailure=true;}};
}
test('future and unauthorized legacy reminders are never claimed',async()=>{
 for(const override of [{remindAt:new Date('2099-01-01')},{deliveryAuthorized:false},{deliveryAuthorized:undefined},{userId:null}]) {const f=fixture(override);assert.equal(await f.worker.processOne(),false);assert.equal(f.sends,0);assert.equal(f.row.attempts,0);}
});
test('two separate workers claim one due reminder and send once',async()=>{
 const f=fixture();const second=createReminderWorker(f.deps);await Promise.all([f.worker.processOne(),second.processOne()]);assert.equal(f.sends,1);assert.equal(f.row.status,'sent');assert.ok(f.row.sentAt);assert.equal(f.row.attempts,1);
});
test('SMS dispatch and deleted Item cancellation',async()=>{
 const f=fixture({channel:'sms',recipient:'+12125551234'});await f.worker.processOne();assert.equal(f.row.providerId,'sms-id');
 const deleted=fixture();deleted.missing();await deleted.worker.processOne();assert.equal(deleted.sends,0);assert.equal(deleted.row.status,'cancelled');
});
test('bounded retries use exponential backoff and safe error category',async()=>{
 const f=fixture();f.fail();await f.worker.processOne();assert.equal(f.row.status,'pending');assert.equal(f.row.lastError,'Delivery attempt failed');assert.equal(f.row.sentAt,undefined);
 assert.equal(await f.worker.processOne(),false);f.advance(30000);await f.worker.processOne();assert.equal(f.row.attempts,2);assert.equal(await f.worker.processOne(),false);f.advance(60000);await f.worker.processOne();assert.equal(f.row.status,'failed');assert.equal(f.sends,3);f.advance(100000);assert.equal(await f.worker.processOne(),false);
});
test('expired leases recover; final expired attempt becomes failed',async()=>{
 const f=fixture({status:'processing',leaseUntil:new Date('2029-12-31'),attempts:1});await f.worker.processOne();assert.equal(f.sends,1);assert.equal(f.row.attempts,2);
 const exhausted=fixture({status:'processing',leaseUntil:new Date('2029-12-31'),attempts:3});await exhausted.worker.processOne();assert.equal(exhausted.row.status,'failed');assert.equal(exhausted.sends,0);
 const leased=fixture({status:'processing',leaseUntil:new Date('2031-01-01')});assert.equal(await leased.worker.processOne(),false);
});
test('failed completion write leaves recoverable lease after provider acceptance',async()=>{
 const f=fixture();f.writeFailure();await assert.rejects(f.worker.processOne());assert.equal(f.sends,1);assert.equal(f.row.status,'processing');assert.ok(f.row.claimToken);assert.equal(f.row.sentAt,undefined);
});
test('worker config rejects invalid values',()=>{
 assert.throws(()=>workerConfig({REMINDER_MAX_ATTEMPTS:'0'}));assert.throws(()=>workerConfig({REMINDER_LEASE_MS:'100'}));
});
test('schema persists worker state and defaults delivery to unauthorized',async()=>{
 const Reminder=require('../models/Reminder');const row=new Reminder(valid);assert.equal(row.deliveryAuthorized,false);assert.equal(row.userId,null);assert.equal(row.attempts,0);
 for(const status of ['processing','cancelled','sent','failed']){row.status=status;await row.validate();}
});
test('server startup preserves route mounts and ping, worker disabled by default',async()=>{
 const mounts=[];const handlers={};let listened=false;
 const app={use(...args){mounts.push(args);},get(route,fn){handlers[route]=fn;},listen(port){assert.equal(port,'5000');listened=true;}};
 const express=()=>app;express.json=()=> 'json';
 load('server.js',{
   express,cors:()=> 'cors',mongoose:{connect(){return Promise.resolve();},connection:{readyState:1}},
   './routes/auth':'auth','./routes/items':'items','./routes/reminders':'reminders'
 });
 await new Promise(resolve=>setImmediate(resolve));
 assert.ok(listened);assert.ok(mounts.some(args=>args[0]==='/api'&&args[1]==='auth'));
 assert.ok(mounts.some(args=>args[0]==='/api/items'&&args[1]==='items'));
 const res=response();handlers['/api/ping']({},res);assert.equal(res.body.message,'PostIt! app is up');assert.equal(res.body.db,'connected');
});
test('default delivery is mock, requires no credentials and distinguishes results',async()=>{
 const {createReminderDelivery,deliveryMode}=require('../services/reminderDelivery');
 const delivery=createReminderDelivery({env:{}});
 assert.equal(deliveryMode({}),'mock');assert.match(await delivery.sendEmail(valid),/^mock-email-/);assert.match(await delivery.sendSms(valid),/^mock-sms-/);
 assert.throws(()=>deliveryMode({REMINDER_DELIVERY_MODE:'invalid'}));
});
test('authorized POST-created record flows through mock worker when due',async()=>{
 const f=fixture({deliveryAuthorized:false,userId:null,remindAt:new Date('2099-01-01')});
 f.deps.config=workerConfig({REMINDER_DELIVERY_MODE:'mock'});
 f.deps.Item={async exists(query){assert.equal(query._id,valid.itemId);assert.equal(query.userId,undefined);return true;}};
 delete f.deps.sendEmail;delete f.deps.sendSms;
 const controller=load('controllers/reminderController.js',{
   '../models/Reminder':{async create(value){Object.assign(f.row,value,{remindAt:new Date(value.remindAt)});return f.row;}},
   '../models/Item':{async findOne(){return {};}},'../lib/reminderValidation':{validateReminder}
 });
 const res=response();await controller.createReminder({body:valid,user:{id:'aaaaaaaaaaaaaaaaaaaaaaaa'}},res);assert.equal(res.code,201);assert.equal(res.body.reminder.status,'pending');
 const worker=createReminderWorker(f.deps);assert.equal(await worker.processOne(),false);
 f.advance(new Date(valid.remindAt)-new Date('2030-01-01'));
 assert.equal(await worker.processOne(),true);assert.equal(f.row.status,'sent');assert.equal(f.row.deliveryMode,'mock');assert.match(f.row.providerId,/^mock-email-/);assert.equal(f.row.deliveryAuthorized,true);
});
test('sent, failed and cancelled records are terminal and never resent',async()=>{
 for(const status of ['sent','failed','cancelled']){const f=fixture({status});assert.equal(await f.worker.processOne(),false);assert.equal(f.sends,0);}
});
test('mock and live claims cannot recover each other after mode changes',async()=>{
 const f=fixture({deliveryMode:'mock',status:'processing',leaseUntil:new Date('2029-01-01')});assert.equal(await f.worker.processOne(),false);
 const g=fixture({deliveryMode:'live'});g.deps.config=workerConfig({REMINDER_DELIVERY_MODE:'mock'});const mock=createReminderWorker(g.deps);assert.equal(await mock.processOne(),false);
});

test('enabled API worker starts only after connection and index readiness',async()=>{
 const events=[];
 const app={use(){},get(){},listen(){}};const express=()=>app;express.json=()=>({});
 load('server.js',{
  express,cors:()=>({}),mongoose:{connect(){events.push('connect');return Promise.resolve();}},
  './routes/auth':{},'./routes/items':{},'./routes/reminders':{},
  './models/Reminder':{async init(){events.push('indexes');}},
  './workers/reminderWorker':{createReminderWorker(){events.push('create');return {start(){events.push('start');}};}}
 },{REMINDER_WORKER_ENABLED:'true'});
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['connect','indexes','create','start']);
});
