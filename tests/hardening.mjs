import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'expert-studio-sec-'));
const port=48000+Math.floor(Math.random()*15000);
const password='Test-Admin-Password-'+crypto.randomBytes(6).toString('hex');
let madeDist=false;
const dist=path.join(root,'dist');
if(!fs.existsSync(dist)){
  madeDist=true;fs.mkdirSync(dist,{recursive:true});
  fs.copyFileSync(path.join(root,'index.html'),path.join(dist,'index.html'));
}
const server=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,PORT:String(port),DATA_DIR:tmp,UPLOADS_DIR:path.join(tmp,'uploads'),ADMIN_PASSWORD:password,APP_ORIGIN:'http://127.0.0.1:'+port,SITE_URL:'https://studio.example',NODE_ENV:'development',RESEND_API_KEY:'',MAIL_FROM:'',ENABLE_CLIENT_UPLOADS:'false',CLAMAV_SCAN:'false'},stdio:'ignore'});
let adminCookie='';
const base=`http://127.0.0.1:${port}`;
const req=async(route,{method='GET',body,cookie='',origin}={})=>fetch(base+route,{method,headers:{...(body?{'content-type':'application/json'}:{}),...(cookie?{cookie}:{}),...(origin?{origin}:{})},...(body?{body:JSON.stringify(body)}:{})});
try{
  let ready=false;for(let i=0;i<60;i++){try{const r=await req('/api/public');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))};assert.ok(ready,'server ready');
  let r=await req('/');assert.equal(r.status,200);let html=await r.text();assert.match(html,/application\/ld\+json/);assert.match(html,/United States/);assert.match(html,/rel="canonical" href="https:\/\/studio\.example/);assert.match(html,/ProfessionalService/);assert.match(r.headers.get('content-security-policy'),/nonce-/);assert.equal(r.headers.get('x-frame-options'),'DENY');
  r=await req('/admin');html=await r.text();assert.match(html,/noindex,nofollow/);
  r=await req('/services/wix');html=await r.text();assert.match(html,/Wix website packages &amp; pricing/);assert.match(html,/https:\/\/studio\.example\/services\/wix/);
  r=await req('/robots.txt');assert.match(await r.text(),/Sitemap: https:\/\/studio\.example\/sitemap.xml/);
  r=await req('/sitemap.xml');assert.match(await r.text(),/https:\/\/studio\.example\/services\/webflow/);
  r=await req('/api/public');const publicData=await r.json();assert.equal(publicData.uploadCapabilities.privateImages,false);
  r=await req('/api/admin/login',{method:'POST',body:{password}});assert.equal(r.status,200);adminCookie=r.headers.get('set-cookie').split(';')[0];
  let colors={accent:'#1368cb',darkColor:'#0d1c36',lightColor:'#fafafa',textColor:'#222222',cardColor:'#ffffff',accentAlt:'#81cffc',cursorEffect:false,notificationEmail:'alerts@example.com'};
  r=await req('/api/admin/site',{method:'PUT',cookie:adminCookie,body:colors});assert.equal(r.status,200);
  r=await req('/api/public');const pub2=await r.json();assert.equal(pub2.site.darkColor,'#0d1c36');assert.equal(pub2.site.notificationEmail,undefined);r=await req('/api/admin/data',{cookie:adminCookie});assert.equal((await r.json()).site.notificationEmail,'alerts@example.com');assert.equal(pub2.site.cursorEffect,false);
  r=await req('/api/admin/site',{method:'PUT',cookie:adminCookie,body:{accent:'#bad-color'}});assert.equal(r.status,400);
  r=await req('/api/admin/site',{method:'PUT',cookie:adminCookie,origin:'https://attacker.example',body:{accent:'#123456'}});assert.equal(r.status,403);
  const src=await sharp({create:{width:30,height:50,channels:4,background:{r:20,g:100,b:200,alpha:1}}}).png().toBuffer();
  const image='data:image/png;base64,'+src.toString('base64');
  r=await req('/api/admin/upload',{method:'POST',cookie:adminCookie,body:{data:image}});assert.equal(r.status,201);const {url}=await r.json();assert.match(url,/^\/uploads\/[a-f0-9-]+\.webp$/);
  r=await req(url);const data=Buffer.from(await r.arrayBuffer());assert.equal((await sharp(data).metadata()).format,'webp');assert.equal(r.headers.get('x-content-type-options'),'nosniff');
  r=await req('/api/admin/upload',{method:'POST',cookie:adminCookie,body:{data:'data:image/png;base64,'+Buffer.from('<script>alert(1)</script>').toString('base64')}});assert.equal(r.status,400);
  r=await req('/api/admin/upload',{method:'POST',cookie:adminCookie,body:{data:'data:image/svg+xml;base64,'+Buffer.from('<svg/>').toString('base64')}});assert.equal(r.status,400);
  r=await req('/api/client/register',{method:'POST',body:{name:'Client Test',email:'client@sample.com',password:'UniquePassword12345'}});assert.equal(r.status,201);const cookie=r.headers.get('set-cookie').split(';')[0];
  r=await req('/api/client/conversations',{method:'POST',cookie,body:{subject:'Project test'}});assert.equal(r.status,201);const {id:threadId}=await r.json();
  r=await req(`/api/client/conversations/${threadId}/attachments`,{method:'POST',cookie,body:{data:image,name:'example.png'}});assert.equal(r.status,503);
  r=await req(`/api/client/conversations/${threadId}/attachments/${crypto.randomUUID()}`,{cookie:adminCookie});assert.equal(r.status,401);
  console.log('PASS: theme settings, email preferences, SEO metadata, robots/sitemap, CSP, origin checks, secure image transcoding and closed-by-default private uploads');
}catch(err){console.error('FAIL:',err);process.exitCode=1}
finally{server.kill('SIGTERM');fs.rmSync(tmp,{force:true,recursive:true});if(madeDist)fs.rmSync(dist,{recursive:true,force:true})}
