// Explicit opt-in; this never connects to the application's configured database.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const {spawn}=require('node:child_process');
const net=require('node:net');
const path=require('node:path');
const mongoose=require('mongoose');
const Reminder=require('../models/Reminder');
const Item=require('../models/Item');
const root=path.join(__dirname,'..');
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await new Promise(r=>setTimeout(r,50));}throw Error('Timed out waiting for server/worker');}
test('HTTP POST -> due poller -> mock email/SMS acceptance, with concurrent processes',{
 skip:!process.env.REMINDER_TEST_MONGO_URI,timeout:20000
},async()=>{
 const dbName='codex_reminder_e2e_'+randomUUID().replaceAll('-','');
 const children=[];
 try{
  await mongoose.connect(process.env.REMINDER_TEST_MONGO_URI,{dbName,serverSelectionTimeoutMS:3000});await Reminder.init();
  const reservation=net.createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const env={...process.env,JWT_SECRET:randomBytes(48).toString('hex'),JWT_EXPIRES_IN:'1h',JWT_ISSUER:'postit-backend',JWT_AUDIENCE:'postit-api',PORT:String(port),REMINDER_WORKER_ENABLED:'true',REMINDER_DELIVERY_MODE:'mock',REMINDER_POLL_INTERVAL_MS:'50',SENDGRID_API_KEY:'',TWILIO_AUTH_TOKEN:''};
  // Explicit dbName URI prevents child processes from using any default app DB.
  const uri=new URL(process.env.REMINDER_TEST_MONGO_URI);uri.pathname='/'+dbName;env.MONGODB_URI=uri.toString();
  children.push(spawn(process.execPath,['server.js'],{cwd:root,env,stdio:'ignore'}));
  children.push(spawn(process.execPath,['workers/runReminderWorker.js'],{cwd:root,env,stdio:'ignore'}));
  const base='http://127.0.0.1:'+port;
  await until(async()=>{try{return (await (await fetch(base+'/api/ping')).json()).db==='connected';}catch{return false;}});
  const credentials={name:'JWT integration',email:'jwt-test@example.com',password:'test-password'};
  const registered=await fetch(base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  assert.equal(registered.status,201);const registration=await registered.json();assert.equal(registration.token,undefined);
  const loggedIn=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(credentials)});
  assert.equal(loggedIn.status,200);const login=await loggedIn.json();assert.equal(login.message,'Login successful');assert.equal(login.user.id,registration.user.id);assert.ok(login.token);
  const noToken=await fetch(base+'/api/reminders',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(noToken.status,401);
  const denied=await Item.create({boardId:new mongoose.Types.ObjectId(),userId:new mongoose.Types.ObjectId(),content:'Other owner'});
  const crossUser=await fetch(base+'/api/reminders',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},body:JSON.stringify({itemId:String(denied._id),channel:'email',recipient:'test@example.com',remindAt:new Date(Date.now()+60000).toISOString(),message:'Denied'})});assert.equal(crossUser.status,404);
  const item=await Item.create({boardId:new mongoose.Types.ObjectId(),userId:login.user.id,type:'text',content:'Disposable mock test'});
  // Exercise the real router, JWT middleware, projections, and Mongo conditional update.
  const headers={ 'Content-Type':'application/json', Authorization:'Bearer '+login.token };
  const secondUser=await (await fetch(base+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,email:'second@example.com'})})).json();
  const secondLogin=await (await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...credentials,email:'second@example.com'})})).json();
  assert.ok(secondUser.user.id);assert.ok(secondLogin.token);
  const scheduled=await (await fetch(base+'/api/reminders',{method:'POST',headers,body:JSON.stringify({itemId:String(item._id),channel:'email',recipient:'test@example.com',remindAt:new Date(Date.now()+60000).toISOString(),message:'Cancel me'})})).json();
  const cancelId=scheduled.reminder._id;
  for(const [method,url] of [['GET','/api/reminders'],['GET','/api/reminders/'+cancelId],['DELETE','/api/reminders/'+cancelId]]) {
    assert.equal((await fetch(base+url,{method})).status,401);
    assert.equal((await fetch(base+url,{method,headers:{Authorization:'Bearer invalid'}})).status,401);
  }
  for(const method of ['GET','DELETE']) {
    assert.equal((await fetch(base+'/api/reminders/'+cancelId,{method,headers:{Authorization:'Bearer '+secondLogin.token}})).status,404);
    assert.equal((await fetch(base+'/api/reminders/bad',{method,headers})).status,400);
  }
  const detail=await (await fetch(base+'/api/reminders/'+cancelId,{headers})).json();
  assert.equal(detail.reminder._id,cancelId);assert.equal('claimToken' in detail.reminder,false);assert.equal('leaseUntil' in detail.reminder,false);
  const cancellation=await fetch(base+'/api/reminders/'+cancelId,{method:'DELETE',headers});assert.equal(cancellation.status,200);
  const cancelled=await cancellation.json();assert.equal(cancelled.reminder.status,'cancelled');assert.ok(cancelled.reminder.cancelledAt);
  const repeated=await fetch(base+'/api/reminders/'+cancelId,{method:'DELETE',headers});assert.equal(repeated.status,200);
  assert.equal((await repeated.json()).reminder.cancelledAt,cancelled.reminder.cancelledAt);
  const list=await (await fetch(base+'/api/reminders?itemId='+item._id+'&status=cancelled&limit=1',{headers})).json();
  assert.equal(list.reminders.length,1);assert.equal(list.reminders[0]._id,cancelId);assert.equal(list.pagination.hasMore,false);
  assert.equal((await fetch(base+'/api/reminders?limit=101',{headers})).status,400);
  const foreignList=await (await fetch(base+'/api/reminders',{headers:{Authorization:'Bearer '+secondLogin.token}})).json();assert.equal(foreignList.reminders.length,0);
  // Make the cancelled row due: neither concurrent poller may claim it.
  await Reminder.updateOne({_id:cancelId},{$set:{remindAt:new Date(Date.now()-1000)}});
  const ids=[];const remindAt=new Date(Date.now()+1500);
  for(const channel of ['email','sms']){
   const response=await fetch(base+'/api/reminders',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+login.token},body:JSON.stringify({itemId:String(item._id),channel,recipient:channel==='email'?'test@example.com':'+12125551234',remindAt:remindAt.toISOString(),message:'Mock only'})});
   assert.equal(response.status,201);const {reminder}=await response.json();assert.equal(reminder.status,'pending');assert.equal(reminder.deliveryAuthorized,true);assert.equal(reminder.userId,login.user.id);ids.push(reminder._id);
  }
  const before=await Reminder.find({_id:{$in:ids}});assert.ok(before.every(r=>r.status==='pending'));assert.ok(before.every(r=>r.attempts===0));
  await until(async()=>await Reminder.countDocuments({_id:{$in:ids},status:'sent'})===2);
  const after=await Reminder.find({_id:{$in:ids}});for(const reminder of after){assert.equal(reminder.attempts,1);assert.equal(reminder.deliveryMode,'mock');assert.match(reminder.providerId,/^mock-(email|sms)-/);assert.ok(reminder.sentAt>=remindAt);}
  const cancelledAfter=await Reminder.findById(cancelId);assert.equal(cancelledAfter.status,'cancelled');assert.equal(cancelledAfter.attempts,0);
  assert.equal((await fetch(base+'/api/reminders/'+ids[0],{method:'DELETE',headers})).status,409);
  // Terminal reminders remain untouched over further polling cycles.
  await new Promise(r=>setTimeout(r,150));assert.ok((await Reminder.find({_id:{$in:ids}})).every(r=>r.attempts===1));
 }finally{
  await Promise.all(children.map(async child=>{if(child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await exited;}));
  if(mongoose.connection.readyState===1){assert.equal(mongoose.connection.name,dbName);await mongoose.connection.dropDatabase();}
  await mongoose.disconnect();
 }
});
