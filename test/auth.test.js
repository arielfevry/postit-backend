const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const jwt=require('jsonwebtoken');
const fs=require('node:fs');const vm=require('node:vm');const path=require('node:path');
const {signAccessToken,verifyAccessToken,JwtConfigurationError}=require('../lib/jwt');
const id='aaaaaaaaaaaaaaaaaaaaaaaa';
const env={JWT_SECRET:randomBytes(48).toString('hex'),JWT_EXPIRES_IN:'1h'};
function load(file,deps){const module={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),{module,require(name){if(name in deps)return deps[name];throw Error(name);},console:{error(){}}});return module.exports;}
function res(){return {code:200,status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}
function middleware(config=env,exists=true){return load('middleware/authenticate.js',{'../models/User':{async exists(query){assert.equal(query._id,id);return exists;}},'../lib/jwt':{verifyAccessToken:token=>verifyAccessToken(token,config),JwtConfigurationError}});}
test('HS256 access tokens contain verified subject, issuer, audience and expiry',()=>{
 const claims=verifyAccessToken(signAccessToken(id,env),env);assert.equal(claims.sub,id);assert.equal(claims.iss,'postit-backend');assert.equal(claims.aud,'postit-api');assert.equal(claims.exp-claims.iat,3600);
});
test('valid Bearer token identifies existing user and calls next',async()=>{
 const req={get:()=> 'Bearer '+signAccessToken(id,env)};let called=false;await middleware()(req,res(),()=>{called=true;});assert.ok(called);assert.equal(req.user.id,id);
});
test('missing/malformed headers, invalid and expired tokens return 401',async()=>{
 const expired=signAccessToken(id,{...env,JWT_EXPIRES_IN:'1s'});
 const decoded=jwt.decode(expired);const expiredToken=jwt.sign({sub:id,exp:decoded.iat-1},env.JWT_SECRET,{algorithm:'HS256',issuer:'postit-backend',audience:'postit-api'});
 const signed=options=>jwt.sign({sub:id},env.JWT_SECRET,{algorithm:'HS256',expiresIn:'1h',issuer:'postit-backend',audience:'postit-api',...options});
 for(const header of [undefined,'','Basic abc','Bearer','Bearer a b','Bearer invalid','Bearer '+expiredToken,'Bearer '+signed({issuer:'other'}),'Bearer '+signed({audience:'other'}),'Bearer '+signed({algorithm:'HS384'}),'Bearer '+signAccessToken(id,{...env,JWT_SECRET:randomBytes(48).toString('hex')})]){
  const response=res();await middleware()({get:()=>header},response,()=>assert.fail('must reject'));assert.equal(response.code,401);
 }
});
test('deleted user and user database failures are handled safely',async()=>{
 const req={get:()=> 'Bearer '+signAccessToken(id,env)};let response=res();await middleware(env,false)(req,response,()=>assert.fail());assert.equal(response.code,401);
 const auth=load('middleware/authenticate.js',{'../models/User':{async exists(){throw Error('private db detail');}},'../lib/jwt':{verifyAccessToken:token=>verifyAccessToken(token,env),JwtConfigurationError}});
 response=res();await auth(req,response,()=>assert.fail());assert.equal(response.code,500);assert.equal(response.body.message,'Internal server error');
});
test('missing, blank or short JWT_SECRET never signs or verifies with a fallback',async()=>{
 const token=signAccessToken(id,env);
 for(const config of [{},{JWT_SECRET:''},{JWT_SECRET:' '},{JWT_SECRET:'short'}]){
  assert.throws(()=>signAccessToken(id,config),JwtConfigurationError);assert.throws(()=>verifyAccessToken(token,config),JwtConfigurationError);
  const response=res();await middleware(config)({get:()=> 'Bearer '+token},response,()=>assert.fail('must fail closed'));assert.equal(response.code,500);assert.equal(response.body.message,'Authentication is not configured');
 }
});
test('tokens without expiry or valid ObjectId subject are rejected',()=>{
 for(const payload of [{sub:id},{sub:'bad',exp:Math.floor(Date.now()/1000)+60}]){const token=jwt.sign(payload,env.JWT_SECRET,{algorithm:'HS256',issuer:'postit-backend',audience:'postit-api'});assert.throws(()=>verifyAccessToken(token,env));}
});
function controller(config=env){let registered;let hashed;const user={_id:id,name:'Existing name',email:'test@example.com',password:'hashed'};
 const api=load('controllers/authController.js',{'../models/User':{async findOne(){return user;},async create(value){registered=value;return {_id:id,...value};}},bcryptjs:{async compare(password){return password==='correct';},async hash(password,rounds){hashed={password,rounds};return 'hashed';}},'../lib/jwt':{signAccessToken:userId=>signAccessToken(userId,config)}});
 return {api,user,get registered(){return registered;},get hashed(){return hashed;}};
}
test('successful login preserves all previous fields and adds token',async()=>{
 const c=controller();const response=res();await c.api.login({body:{email:'test@example.com',password:'correct'}},response);assert.equal(response.code,200);assert.equal(response.body.message,'Login successful');assert.equal(response.body.user.id,id);assert.equal(response.body.user.name,c.user.name);assert.equal(response.body.user.email,c.user.email);assert.equal(verifyAccessToken(response.body.token,env).sub,id);assert.equal(response.body.user.password,undefined);
});
test('login fails safely without JWT_SECRET and preserves invalid credential handling',async()=>{
 const c=controller({});let response=res();await c.api.login({body:{email:'test@example.com',password:'correct'}},response);assert.equal(response.code,500);assert.equal(response.body.token,undefined);assert.equal(response.body.message,undefined);assert.equal(response.body.error,'Internal server error');
 response=res();await c.api.login({body:{email:'test@example.com',password:'wrong'}},response);assert.equal(response.code,401);
 response=res();await c.api.login({body:{}},response);assert.equal(response.code,400);
});
test('register does not depend on JWT_SECRET or issue a token',async()=>{
 let created;let rounds;const api=load('controllers/authController.js',{'../models/User':{async findOne(){return null;},async create(value){created=value;return {_id:id,...value};}},bcryptjs:{async hash(password,cost){rounds=cost;return 'hash';}},'../lib/jwt':{signAccessToken(){assert.fail('register must not issue JWT');}}});
 const response=res();await api.register({body:{name:' Name ',email:'TEST@EXAMPLE.COM',password:'password'}},response);assert.equal(response.code,201);assert.equal(response.body.message,'Registration successful');assert.equal(response.body.user.id,id);assert.equal(created.name,'Name');assert.equal(created.email,'test@example.com');assert.equal(rounds,12);assert.equal(response.body.token,undefined);assert.equal(response.body.user.password,undefined);
});
