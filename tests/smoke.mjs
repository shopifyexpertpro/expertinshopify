import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'expert-studio-test-'));
const port=Number(process.env.TEST_PORT || 39000+Math.floor(Math.random()*20000));
const password='SecureTestPassword'+crypto.randomBytes(5).toString('hex');
const server=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:tmp,UPLOADS_DIR:path.join(tmp,'uploads'),ADMIN_PASSWORD:password,NODE_ENV:'development'},stdio:'ignore'});
const base='http://127.0.0.1:'+port;
let cookie='';
const req=async (route,method='GET',body)=>{
  const res=await fetch(base+'/api'+route,{method,headers:{'content-type':'application/json',...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await res.json();return {status:res.status,data,headers:res.headers};
};
try{
  let ready=false;
  for(let i=0;i<45;i++){try{await req('/public');ready=true;break}catch{await new Promise(r=>setTimeout(r,100))}}
  assert.ok(ready,'API started');
  const pub=(await req('/public')).data;
  assert.ok(pub.services.length>=8);
  assert.ok(pub.projects.length>=3);
  assert.equal((await req('/admin/me')).data.authenticated,false);
  const login=await req('/admin/login','POST',{password});
  assert.equal(login.status,200);
  cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/admin/me')).data.authenticated,true);
  const updated={...pub.site,heroTitle:'Test edited headline'};
  assert.equal((await req('/admin/site','PUT',updated)).status,200);
  assert.equal((await req('/public')).data.site.heroTitle,'Test edited headline');
  const partner={name:'Example test partner',url:'https://example.com',logo:'',sort:0};
  assert.equal((await req('/admin/partners','POST',partner)).status,201);
  assert.equal((await req('/public')).data.partners.length,1);
  assert.equal((await req('/inquiries','POST',{name:'Taylor Example',email:'taylor@example.com',message:'Please build my new Shopify store'})).status,201);
  const s=pub.services[0];
  const order=await req('/orders','POST',{serviceId:s.id,method:'bank',name:'Taylor Example',email:'taylor@example.com',price:1});
  assert.equal(order.status,201);
  const result=(await req('/orders/'+order.data.id)).data.order;
  assert.equal(result.amount,s.price,'Customer cannot override the catalog price');
  assert.equal(result.status,'awaiting_manual_payment');
  assert.equal((await req('/admin/orders/'+order.data.id,'PATCH',{status:'paid',transaction_ref:'BANK-VERIFIED'})).status,200);
  assert.equal((await req('/orders/'+order.data.id)).data.order.status,'paid');
  const data=(await req('/admin/data')).data;
  assert.equal(data.inquiries.length,1);
  assert.equal(data.orders.length,1);
  console.log('PASS: public pages, protected admin, CMS update, partners, inquiries, server-side pricing, order statuses.');
}catch(e){console.error('FAIL:',e);process.exitCode=1}
finally{server.kill('SIGTERM');fs.rmSync(tmp,{recursive:true,force:true});}
