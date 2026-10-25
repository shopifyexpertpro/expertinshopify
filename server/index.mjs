import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const envFile = path.join(root, '.env');
if (fs.existsSync(envFile)) for (const row of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = row.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g,'');
}
const PORT = Number(process.env.PORT || 4000);
const SECURE = process.env.NODE_ENV === 'production';
const appOrigin = (process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL || (SECURE ? '' : 'http://localhost:5173')).replace(/\/$/, '');
const dataDir = path.resolve(process.env.DATA_DIR || here);
const uploadsDir = path.resolve(process.env.UPLOADS_DIR || path.join(root, 'public', 'uploads'));
const privateDir = path.join(dataDir, 'private-attachments');
const clientUploadsEnabled = process.env.ENABLE_CLIENT_UPLOADS === 'true' && process.env.CLAMAV_SCAN === 'true';
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(dataDir, 'data.sqlite'));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS services (id TEXT PRIMARY KEY, platform TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, price INTEGER NOT NULL, delivery INTEGER NOT NULL, features TEXT NOT NULL, badge TEXT DEFAULT '', featured INTEGER DEFAULT 0, active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, platform TEXT NOT NULL, description TEXT NOT NULL, url TEXT DEFAULT '', image TEXT DEFAULT '', tint TEXT DEFAULT 'mint', featured INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS partners (id TEXT PRIMARY KEY, name TEXT NOT NULL, logo TEXT DEFAULT '', url TEXT DEFAULT '', sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, name TEXT NOT NULL, country TEXT DEFAULT '', avatar TEXT DEFAULT '', rating INTEGER DEFAULT 5, text TEXT NOT NULL, project TEXT DEFAULT '', source TEXT DEFAULT 'Fiverr', source_url TEXT DEFAULT '', review_date TEXT DEFAULT '', featured INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, title TEXT NOT NULL, niche TEXT DEFAULT '', description TEXT DEFAULT '', image TEXT DEFAULT '', cost_price TEXT DEFAULT '', sell_price TEXT DEFAULT '', aliexpress_url TEXT DEFAULT '', amazon_url TEXT DEFAULT '', active INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS coupons (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, type TEXT DEFAULT 'percent', value INTEGER NOT NULL, platform TEXT DEFAULT '', service_id TEXT DEFAULT '', min_amount INTEGER DEFAULT 0, max_uses INTEGER DEFAULT 0, expires_at TEXT DEFAULT '', active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, service_id TEXT, service_title TEXT NOT NULL, platform TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT DEFAULT 'USD', customer_name TEXT NOT NULL, customer_email TEXT NOT NULL, customer_phone TEXT DEFAULT '', notes TEXT DEFAULT '', method TEXT NOT NULL, status TEXT DEFAULT 'awaiting_payment', paypal_id TEXT DEFAULT '', transaction_ref TEXT DEFAULT '', created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS inquiries (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT DEFAULT '', service TEXT DEFAULT '', budget TEXT DEFAULT '', message TEXT NOT NULL, status TEXT DEFAULT 'new', created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS admin (id INTEGER PRIMARY KEY CHECK(id=1), salt TEXT NOT NULL, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ix_orders_date ON orders (created_at);
CREATE INDEX IF NOT EXISTS ix_inquiries_date ON inquiries (created_at);`);

// Client accounts and private messaging. This migration retains existing catalog, orders and admin data.
db.exec(`CREATE TABLE IF NOT EXISTS clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS client_sessions (token_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE, order_id TEXT REFERENCES orders(id) ON DELETE SET NULL, subject TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender TEXT NOT NULL CHECK(sender IN ('client','admin')), body TEXT NOT NULL, seen_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_conversation_client ON conversations(client_id, updated_at);
CREATE INDEX IF NOT EXISTS ix_message_thread ON messages(conversation_id, created_at, id);
CREATE INDEX IF NOT EXISTS ix_client_sessions ON client_sessions(client_id);
CREATE TABLE IF NOT EXISTS attachments (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender TEXT NOT NULL CHECK(sender IN ('client','admin')), filename TEXT NOT NULL, storage_key TEXT NOT NULL, media_type TEXT NOT NULL, bytes INTEGER NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE INDEX IF NOT EXISTS ix_attachments_thread ON attachments(conversation_id);`);
if (!db.prepare('PRAGMA table_info(messages)').all().some(c=>c.name==='attachment_id')) db.exec('ALTER TABLE messages ADD COLUMN attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL');
if (!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name==='client_id')) db.exec('ALTER TABLE orders ADD COLUMN client_id TEXT REFERENCES clients(id) ON DELETE SET NULL');
for (const [col,type] of [['original_amount','INTEGER'],['discount_code',"TEXT DEFAULT ''"],['discount_amount','INTEGER DEFAULT 0']]) if (!db.prepare('PRAGMA table_info(orders)').all().some(c=>c.name===col)) db.exec(`ALTER TABLE orders ADD COLUMN ${col} ${type}`);
db.exec('CREATE INDEX IF NOT EXISTS ix_orders_client ON orders(client_id)');

const id = () => crypto.randomUUID();
const settingsDefault = {
  brand: 'Expert in Shopify', seoTitle: 'Expert in Shopify — Shopify, Wix, Squarespace & Webflow Design', seoDescription: 'Conversion-focused Shopify stores and beautiful Wix, Squarespace and Webflow websites for growing brands.', email: 'monirwcoder@gmail.com', phone: '+880 1871-021969', whatsapp: '8801871021969',
  announcement: 'New client special — 30% off your first project',
  heroEyebrow: 'INDEPENDENT DIGITAL STUDIO  ·  EST. 2019',
  heroTitle: 'Your next big thing,', heroAccent: 'beautifully built.',
  heroDescription: 'High-performing Shopify, Wix, Squarespace and Webflow websites. Designed to stand out, built to grow your business.',
  heroButton: 'Explore our work', heroSecondaryButton: 'View services',
  stats: [{value:'6+',label:'Years of experience'}, {value:'300+',label:'Projects delivered'}, {value:'4',label:'Platforms mastered'}],
  platformsEyebrow: 'WHAT WE CREATE', platformsTitle: 'Great ideas deserve great websites.',
  platformDescriptions: {Shopify:'Online stores designed to sell more.', Wix:'Flexible, beautiful websites for growing businesses.', Squarespace:'Elegant, editorial sites with personality.', Webflow:'Immersive sites with limitless creative freedom.'},
  featuredServicesTitle:'Find your perfect fit.', featuredServicesDescription:'Clear deliverables. Fair pricing. No surprises.',
  servicesPageTitle:'Big ideas.', servicesPageAccent:'Clear prices.', servicesPageDescription:'Choose the perfect package for your business. Every service comes with real expertise, thoughtful design and a straightforward checkout.',
  portfolioPageTitle:'Work that', portfolioPageAccent:'works harder.', portfolioPageDescription:'Thoughtful websites, stronger brands and better customer experiences. Take a closer look at what we create.',
  platformsDescription: 'From first launch to next-level growth, find the perfect build for your business.',
  workTitle: 'Selected work, real impact.', workDescription: 'A few of the digital experiences we have brought to life.',
  processTitle: 'Simple process. Serious results.', processDescription: 'Thoughtful collaboration, clear milestones, and work worth showing off.',
  steps: [{title:'Tell us your vision', text:'Share your goals, inspiration and timeline. We map out the details together.'},{title:'We get to work',text:'Design, development and transparent updates at every milestone.'},{title:'Launch with confidence',text:'We test, polish, hand over and support you beyond launch.'}],
  partnersTitle: 'Growing together with great partners.', partnersDescription: 'Collaborations that turn good projects into exceptional ones.',
  contactTitle: 'Have a project in mind?', contactDescription: 'Tell us a little about it. We will get back to you as soon as possible.',
  footerText: 'Thoughtful websites for ambitious brands.', location: 'Bangladesh · Worldwide',
  instagram: '', linkedin: '', facebook: '', accent: '#00a77b', accentAlt:'#70e6bc', darkColor:'#0c1d17', lightColor:'#f7faf8', textColor:'#17231f', cardColor:'#ffffff',
  cursorEffect:true, notificationEmail:'', notifyInquiries:true, notifyOrders:true, notifyMessages:true,
  audienceLine:'Serving brands in the USA, UK, Australia and Canada — and worldwide.', seoKeywords:'Shopify developer, Wix website design, Squarespace expert, Webflow developer, ecommerce agency',
  texts:{}
};
const paymentDefault = {
  paypalEnabled: false, payoneerEnabled: true, bankEnabled: true,
  payoneerEmail: '', payoneerLink: '', payoneerInstructions:'Request a Payoneer payment link using your order reference. We confirm your order after payment is verified.',
  bankName: '', bankAccountName: '', bankAccountNumber: '', bankRouting: '', bankSwift: '', bankInstructions: 'Use your order reference in the transfer details. We verify manual payments before starting work.',
  currency: 'USD'
};
const has = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n > 0;
const setSetting = (key, val) => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(val));
const getSetting = (key) => JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || '{}');
if (!has('settings')) { setSetting('site', settingsDefault); setSetting('payment', paymentDefault); }
else {
  setSetting('site', {...settingsDefault,...getSetting('site')});
  setSetting('payment', {...paymentDefault,...getSetting('payment')});
}
if (!has('services')) {
  const entries = [
    ['Shopify','Shopify Starter Store','A stunning, conversion-ready Shopify store that makes a great first impression.',399,7,['Up to 5 professionally designed pages','Responsive Shopify theme setup','Essential app integrations','Basic on-page SEO','30-day post-launch support'],'Popular',1],
    ['Shopify','Custom Shopify Experience','Advanced theme development for brands ready to stand apart.',899,14,['Custom Shopify Liquid sections','Up to 10 custom pages','Product and collection templates','Performance and SEO optimization','Conversion-focused user experience'],'Best seller',1],
    ['Shopify','Shopify Speed & CRO','Make an existing store faster, smoother and easier to shop.',249,5,['Storefront performance audit','Image and code optimization','Core Web Vitals improvements','Conversion recommendations','Before-and-after report'],'',0],
    ['Wix','Wix Business Website','A polished Wix presence that is easy for your team to update.',299,6,['Up to 5 responsive pages','Wix editor setup','Contact forms and integrations','Mobile optimization','Basic SEO setup'],'',1],
    ['Wix','Wix Online Store','Sell your products with a clean, branded Wix ecommerce website.',549,10,['Store setup with up to 20 products','Payment and shipping configuration','Custom branded layouts','Product and collection pages','Handover walkthrough'],'',0],
    ['Squarespace','Squarespace Signature Site','A refined visual identity and beautiful Squarespace website.',349,7,['Up to 6 designed pages','Mobile-first customization','Newsletter and forms','SEO essentials','Editor walkthrough'],'',1],
    ['Squarespace','Squarespace Commerce','Thoughtful ecommerce design for premium products and services.',649,12,['Commerce website setup','Up to 25 products','Checkout and shipping settings','Custom CSS styling','Launch support'],'',0],
    ['Webflow','Webflow Launch Website','Beautiful animations and a fast, responsive Webflow site.',499,8,['Up to 5 bespoke pages','Responsive Webflow build','CMS collections setup','Interactions and animations','SEO and speed basics'],'Trending',1],
    ['Webflow','Webflow CMS & Custom Build','A scalable Webflow experience with tailored content management.',999,16,['Up to 12 custom pages','CMS architecture and templates','Advanced interactions','Reusable design system','Training and 30-day support'],'',0]
  ];
  const insert = db.prepare('INSERT INTO services(id,platform,title,description,price,delivery,features,badge,featured,sort) VALUES(?,?,?,?,?,?,?,?,?,?)');
  entries.forEach((e,i) => insert.run(id(),e[0],e[1],e[2],e[3],e[4],JSON.stringify(e[5]),e[6],e[7],i));
}
if (!has('projects')) {
  const projects = [
    ['Fitice','Shopify','An energetic ecommerce experience built to move.','https://fitice.shop/','', 'lime'],
    ['CompressPNG','Webflow','Simple, powerful utility meets crisp digital design.','https://compresspng.com/','','lavender'],
    ['Fluxwell — FluxTrainer','Shopify','Product storytelling that puts wellness first.','https://thefluxwell.com/','','peach'],
    ['Trybello','Shopify','Distinctive beauty commerce with a premium feel.','https://trybello.com/','','sky'],
    ['Pamela J Booker','Squarespace','A confident brand presence with personality.','https://www.pamelajbooker.com/','','sand']
  ];
  const insert = db.prepare('INSERT INTO projects(id,title,platform,description,url,image,tint,sort) VALUES(?,?,?,?,?,?,?,?)');
  projects.forEach((p,i)=>insert.run(id(),...p,i));
}
if (!has('admin')) {
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(12).toString('base64url');
  if (pw.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO admin(id,salt,password_hash) VALUES(1,?,?)').run(salt, crypto.scryptSync(pw,salt,64).toString('hex'));
  console.log('\n'+ '='.repeat(55) +'\nADMIN LOGIN — first run ONLY\nPassword: ' + pw + '\nStore this password securely. Change by updating the admin table or resetting the database before launch.\n' + '='.repeat(55)+'\n');
}
// Recovery for hosted installs without shell access: set ADMIN_RESET_PASSWORD, restart, sign in, then delete the variable.
if (process.env.ADMIN_RESET_PASSWORD) {
  const pw = process.env.ADMIN_RESET_PASSWORD;
  if (pw.length < 12) throw new Error('ADMIN_RESET_PASSWORD must contain at least 12 characters.');
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('UPDATE admin SET salt=?,password_hash=? WHERE id=1').run(salt, crypto.scryptSync(pw,salt,64).toString('hex'));
  db.prepare('DELETE FROM sessions').run();
  console.log('Admin password was reset from ADMIN_RESET_PASSWORD. Remove that variable now, or every restart will reset it again.');
}

const selectServices = () => db.prepare('SELECT * FROM services ORDER BY sort, created_at').all().map(s=>({...s,features: JSON.parse(s.features), featured:!!s.featured, active:!!s.active}));
const selectProjects = () => db.prepare('SELECT * FROM projects ORDER BY sort,title').all().map(p=>({...p,featured:!!p.featured}));
const publicSite = () => {const {notificationEmail,notifyInquiries,notifyOrders,notifyMessages,...publicSiteSettings}=getSetting('site');return publicSiteSettings};
const selectReviews = () => db.prepare('SELECT * FROM reviews ORDER BY sort,review_date DESC,rowid').all().map(r=>({...r,featured:!!r.featured}));
const publicData = () => ({uploadCapabilities:{privateImages:clientUploadsEnabled},site:publicSite(),payment:(()=>{const p=getSetting('payment');return {...p,paypalEnabled: !!(p.paypalEnabled && process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)};})(),services:selectServices().filter(s=>s.active),projects:selectProjects(),partners:db.prepare('SELECT * FROM partners ORDER BY sort,name').all(),reviews:selectReviews(),products:db.prepare('SELECT * FROM products WHERE active=1 ORDER BY sort,title').all()});
const json = (res, code, obj) => { const body=JSON.stringify(obj);res.writeHead(code, {'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body); };
const sendError=(res,code,message)=>json(res,code,{error:message});
const decode=v=>{try{return decodeURIComponent(v)}catch{return ''}};
const getCookie=(req,name)=>{const cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decode)).filter(x=>x.length===2));return cookies[name];};
const isAuthed=(req)=>{const value=getCookie(req,'studio_session');if (!value || !/^[0-9a-f]{64}$/.test(value))return false;const result=db.prepare('SELECT 1 FROM sessions WHERE token_hash=? AND expires_at>?').get(crypto.createHash('sha256').update(value).digest('hex'),Date.now());return !!result;};
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const safeClient = c => c && ({id:c.id,name:c.name,email:c.email,created_at:c.created_at});
const getClient = req => {
  const token=getCookie(req,'studio_client');
  if(!token || !/^[a-f0-9]{64}$/.test(token))return null;
  return db.prepare('SELECT c.id,c.name,c.email,c.created_at FROM client_sessions s JOIN clients c ON c.id=s.client_id WHERE s.token_hash=? AND s.expires_at>?').get(tokenHash(token),Date.now())||null;
};
const clientCookie = (res,token) => res.setHeader('Set-Cookie',`studio_client=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${token?604800:0}${SECURE?'; Secure':''}`);
const startClientSession=(res,clientId)=>{
  const token=crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM client_sessions WHERE expires_at<=?').run(Date.now());
  db.prepare('INSERT INTO client_sessions(token_hash,client_id,expires_at) VALUES(?,?,?)').run(tokenHash(token),clientId,Date.now()+7*86400000);
  clientCookie(res,token);
};
// Server-sent events deliver immediate inbox updates; actual conversation data is always fetched through authenticated APIs.
const listeners=new Set();
const openEvents=(req,res,role,clientId=null)=>{
  res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no','x-content-type-options':'nosniff'});
  res.write('event: ready\ndata: {}\n\n');
  const listener={res,role,clientId,req};listeners.add(listener);
  const timer=setInterval(()=>{
    const valid=role==='admin'?isAuthed(req):getClient(req)?.id===clientId;
    if(!valid){clearInterval(timer);listeners.delete(listener);res.end();return;}
    try{res.write(': heartbeat\n\n')}catch{clearInterval(timer);listeners.delete(listener)}
  },20000);
  res.on('close',()=>{clearInterval(timer);listeners.delete(listener)});
};
const notifyConversation=(clientId)=>{
  for(const l of listeners){
    if(l.role==='admin' && isAuthed(l.req) || l.role==='client' && l.clientId===clientId && getClient(l.req)?.id===clientId){
      try{l.res.write('event: inbox\ndata: {}\n\n')}catch{listeners.delete(l)}
    }
  }
};
const conversationsList=(asAdmin,clientId=null)=>{
  const select=`SELECT t.id,t.client_id,t.order_id,t.subject,t.created_at,t.updated_at,c.name AS client_name,c.email AS client_email,
    o.service_title AS service_title,
    (SELECT m.body FROM messages m WHERE m.conversation_id=t.id ORDER BY m.created_at DESC,m.rowid DESC LIMIT 1) AS last_message,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=t.id AND m.sender=? AND m.seen_at IS NULL) AS unread_count
    FROM conversations t JOIN clients c ON c.id=t.client_id LEFT JOIN orders o ON o.id=t.order_id`;
  return asAdmin?db.prepare(select+' ORDER BY t.updated_at DESC, t.rowid DESC LIMIT 500').all('client'):
    db.prepare(select+' WHERE t.client_id=? ORDER BY t.updated_at DESC, t.rowid DESC LIMIT 100').all('admin',clientId);
};
const getThread=(conversationId,asAdmin,clientId=null)=>{
  const t=db.prepare('SELECT t.id,t.client_id,t.order_id,t.subject,c.name AS client_name,c.email AS client_email FROM conversations t JOIN clients c ON c.id=t.client_id WHERE t.id=?').get(conversationId);
  return t && (asAdmin||t.client_id===clientId)?t:null;
};
const threadMessages=(id)=>db.prepare(`SELECT m.id,m.sender,m.body,m.seen_at,m.created_at, a.id AS attachment_id,a.filename AS attachment_name,a.media_type AS attachment_type FROM messages m LEFT JOIN attachments a ON a.id=m.attachment_id WHERE m.conversation_id=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT 200`).all(id).reverse();
const markRead=(id,sender)=>{
  const info=db.prepare('UPDATE messages SET seen_at=CURRENT_TIMESTAMP WHERE conversation_id=? AND sender=? AND seen_at IS NULL').run(id,sender);
  return info.changes>0;
};
const sendMessage=(threadId,sender,body,attachmentId=null)=>{
  const msg=str(body,4001);if((!msg && !attachmentId) || msg.length>4000)throw Object.assign(new Error('Write a message or attach an image (max 4,000 characters)'),{status:400});
  if(attachmentId){
    const a=db.prepare('SELECT id FROM attachments WHERE id=? AND conversation_id=? AND sender=?').get(attachmentId,threadId,sender);
    if(!a)throw Object.assign(new Error('Invalid or unauthorized attachment'),{status:403});
    if(db.prepare('SELECT 1 FROM messages WHERE attachment_id=?').get(attachmentId))throw Object.assign(new Error('Attachment already sent'),{status:409});
  }
  db.prepare('INSERT INTO messages(id,conversation_id,sender,body,attachment_id) VALUES(?,?,?,?,?)').run(id(),threadId,sender,msg,attachmentId);
  db.prepare('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(threadId);
};
const sendEmailNotification=async(type, title, details, replyTo='')=>{
  const settings=getSetting('site');
  if(!settings.notificationEmail || !settings['notify'+type] || !validEmail(settings.notificationEmail) || !process.env.RESEND_API_KEY || !process.env.MAIL_FROM)return;
  try{
    const textContent=[title,details,`Open the dashboard: ${appOrigin||'your website URL'}/admin`].join('\n\n');
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{'Authorization':`Bearer ${process.env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:process.env.MAIL_FROM,to:[settings.notificationEmail],subject:`[${settings.brand}] ${title}`,text:textContent,...(validEmail(replyTo)?{reply_to:replyTo}:{})}),signal:AbortSignal.timeout(10000)});
    if(!response.ok)console.error('Notification email failed:',response.status);
  }catch(e){console.error('Notification email error:',e.message)}
};
const notifyAsync=(...args)=>{void sendEmailNotification(...args)};
// Restrict uploads to decoded raster images; rewriting pixels discards embedded scripts/metadata.
async function processImageData(encoded){
  const match=String(encoded||'').match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/);
  if(!match)throw Object.assign(new Error('PNG, JPG or WebP images only'),{status:400});
  if(match[2].length>3_000_000)throw Object.assign(new Error('Image limit is 2MB'),{status:413});
  const original=Buffer.from(match[2],'base64');
  if(original.length<20||original.length>2_000_000)throw Object.assign(new Error('Image must be under 2MB'),{status:413});
  try{
    const decoded=sharp(original,{failOn:'warning',limitInputPixels:12_000_000,animated:false});
    const meta=await decoded.metadata();
    if(!['jpeg','png','webp'].includes(meta.format)||!meta.width||!meta.height||meta.pages>1)throw Error('Invalid raster image');
    const cleaned=await decoded.rotate().resize({width:1600,height:2400,fit:'inside',withoutEnlargement:true}).webp({quality:78,effort:4}).toBuffer();
    return {original,cleaned};
  }catch{throw Object.assign(new Error('Corrupt or unsafe image rejected'),{status:400})}
}
// Fail-closed ClamAV check for private client uploads. ClamAV must be installed and its signatures updated.
const scanAntivirus=async(buffer)=>{
  const tmp=path.join(privateDir,id()+'.scan');
  fs.writeFileSync(tmp,buffer,{mode:0o600,flag:'wx'});
  try{
    await new Promise((resolve,reject)=>{
      const child=spawn('clamscan',['--no-summary','--infected','--',tmp],{stdio:'ignore'});
      const timer=setTimeout(()=>child.kill('SIGKILL'),20_000);
      child.once('error',()=>{clearTimeout(timer);reject(Object.assign(new Error('Virus scanner unavailable; upload rejected'),{status:503}))});
      child.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(Object.assign(new Error('Antivirus check failed; upload rejected'),{status:422}))});
    });
  }finally{try{fs.unlinkSync(tmp)}catch{}}
};
const parseBody = async req => {
  let data='';for await(const chunk of req){data+=chunk;if(data.length>5_000_000)throw Object.assign(new Error('Request too large'),{status:413});}
  try {return data?JSON.parse(data):{};}catch {throw Object.assign(new Error('Invalid JSON'),{status:400});}
};
const fields = (body, allowed) => Object.fromEntries(Object.entries(body||{}).filter(([k])=>allowed.includes(k)));
const str=(v,max=1000)=>String(v??'').trim().slice(0,max);
const validEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const validHttpLink = v => !v || /^https?:\/\//i.test(v) || /^\/uploads\/[a-zA-Z0-9._-]+$/.test(v);
const allowedEntity = {
  services:['platform','title','description','price','delivery','features','badge','featured','active','sort'],
  projects:['title','platform','description','url','image','tint','featured','sort'],
  partners:['name','logo','url','sort'],
  reviews:['name','country','avatar','rating','text','project','source','source_url','review_date','featured','sort'],
  products:['title','niche','description','image','cost_price','sell_price','aliexpress_url','amazon_url','active','sort'],
  coupons:['code','type','value','platform','service_id','min_amount','max_uses','expires_at','active']
};
const normalizeEntity=(table,raw,old={})=>{
  const next={...old,...fields(raw,allowedEntity[table])};
  if(table==='services'){
    if(!['Shopify','Wix','Squarespace','Webflow'].includes(next.platform))throw Error('Choose a valid platform');
    next.title=str(next.title,110);next.description=str(next.description,500);next.badge=str(next.badge,40);
    next.price=Number(next.price);next.delivery=Number(next.delivery);next.sort=Number(next.sort||0);
    if(!Number.isInteger(next.price)||next.price<1||next.price>1_000_000)throw Error('Price must be between $1 and $1,000,000');
    if(!Number.isInteger(next.delivery)||next.delivery<1||next.delivery>365)throw Error('Delivery must be between 1 and 365 days');
    next.features=Array.isArray(next.features)?next.features.map(x=>str(x,150)).filter(Boolean).slice(0,20):[];
    next.active=next.active?1:0;next.featured=next.featured?1:0;
  } else if (table==='projects'){
    next.title=str(next.title,110);next.description=str(next.description,400);next.platform=str(next.platform,45);next.url=str(next.url,800);next.image=str(next.image,800);next.tint=str(next.tint,20);next.sort=Number(next.sort||0);next.featured=next.featured?1:0;
    if(!validHttpLink(next.url)||!validHttpLink(next.image))throw Error('Use HTTPS URLs for links and images');
  } else if (table==='reviews'){
    next.name=str(next.name,80);next.country=str(next.country,60);next.avatar=str(next.avatar,800);next.text=str(next.text,2000);next.project=str(next.project,120);next.source_url=str(next.source_url,800);next.sort=Number(next.sort||0);next.featured=next.featured?1:0;
    next.rating=Number(next.rating);if(!Number.isInteger(next.rating)||next.rating<1||next.rating>5)throw Error('Rating must be 1 to 5 stars');
    next.source=['Fiverr','Upwork','Google','Direct','Other'].includes(next.source)?next.source:'Fiverr';
    next.review_date=/^\d{4}-\d{2}-\d{2}$/.test(str(next.review_date,10))?str(next.review_date,10):'';
    if(!next.text)throw Error('Review text is required');
    if(!validHttpLink(next.avatar)||!validHttpLink(next.source_url))throw Error('Use HTTPS URLs for the photo and review link');
  } else if (table==='products'){
    next.title=str(next.title,110);next.niche=str(next.niche,60);next.description=str(next.description,600);next.image=str(next.image,800);next.cost_price=str(next.cost_price,30);next.sell_price=str(next.sell_price,30);
    next.aliexpress_url=str(next.aliexpress_url,1500);next.amazon_url=str(next.amazon_url,1500);next.sort=Number(next.sort||0);next.active=next.active?1:0;
    if(![next.image,next.aliexpress_url,next.amazon_url].every(validHttpLink))throw Error('Use HTTPS URLs for the image and product links');
  } else if (table==='coupons'){
    next.code=str(next.code,30).toUpperCase();if(!/^[A-Z0-9_-]{3,30}$/.test(next.code))throw Error('Code must be 3–30 letters, numbers, - or _');
    if(db.prepare('SELECT 1 FROM coupons WHERE code=? AND id!=?').get(next.code,old.id||''))throw Error('A discount code with this name already exists');
    next.type=next.type==='fixed'?'fixed':'percent';next.value=Number(next.value);
    if(!Number.isInteger(next.value)||next.value<1||next.value>(next.type==='percent'?100:1_000_000))throw Error(next.type==='percent'?'Percent must be 1 to 100':'Amount must be a whole number above 0');
    next.platform=['Shopify','Wix','Squarespace','Webflow'].includes(next.platform)?next.platform:'';
    next.service_id=str(next.service_id,60);if(next.service_id&&!db.prepare('SELECT 1 FROM services WHERE id=?').get(next.service_id))throw Error('Choose a valid service');
    next.min_amount=Math.max(0,Math.floor(Number(next.min_amount)||0));next.max_uses=Math.max(0,Math.floor(Number(next.max_uses)||0));
    next.expires_at=/^\d{4}-\d{2}-\d{2}$/.test(str(next.expires_at,10))?str(next.expires_at,10):'';next.active=next.active?1:0;
  } else {
    next.name=str(next.name,110);next.logo=str(next.logo,800);next.url=str(next.url,800);next.sort=Number(next.sort||0);
    if(!validHttpLink(next.url)||!validHttpLink(next.logo))throw Error('Use HTTPS URLs for links and logos');
  }
  if(!(table==='partners'||table==='reviews'?next.name:table==='coupons'?next.code:next.title))throw Error('Name or title is required');
  return next;
};
// Discount codes are always re-checked here so the browser can never set its own price.
const activeCouponUses=code=>db.prepare("SELECT COUNT(*) AS n FROM orders WHERE discount_code=? AND status NOT IN ('cancelled','refunded')").get(code).n;
const applyCoupon=(service,rawCode)=>{
  const code=str(rawCode,30).toUpperCase();if(!code)return {code:'',discount:0,total:service.price};
  const fail=m=>{throw Object.assign(new Error(m),{status:400})};
  const c=db.prepare('SELECT * FROM coupons WHERE code=? AND active=1').get(code);
  if(!c)fail('This discount code is not valid');
  if(c.expires_at&&c.expires_at<new Date().toISOString().slice(0,10))fail('This discount code has expired');
  if(c.platform&&c.platform!==service.platform)fail(`This code only works for ${c.platform} services`);
  if(c.service_id&&c.service_id!==service.id)fail('This code does not apply to this service');
  if(c.min_amount&&service.price<c.min_amount)fail(`This code needs a package of at least ${c.min_amount}`);
  if(c.max_uses&&activeCouponUses(c.code)>=c.max_uses)fail('This discount code has been fully used');
  const discount=Math.min(c.type==='percent'?Math.round(service.price*c.value/100):c.value,service.price-1);
  return {code:c.code,discount,total:service.price-discount};
};
const buckets = new Map();
// Behind a reverse proxy (Caddy) every socket comes from the proxy, so use the client IP it appends to X-Forwarded-For.
const clientIp = req => (process.env.TRUST_PROXY==='true' && String(req.headers['x-forwarded-for']||'').split(',').pop().trim()) || req.socket.remoteAddress || 'unknown';
setInterval(()=>{const now=Date.now();for(const [k,x] of buckets)if(now-x.start>3600000)buckets.delete(k)},600000).unref();
const limited = (req,tag,max=12,windowMs=60000)=>{
  const key=tag+':'+clientIp(req);let x=buckets.get(key);
  if(!x||Date.now()-x.start>windowMs)x={start:Date.now(),count:0};x.count++;buckets.set(key,x);return x.count>max;
};
const sameOrigin = req => {
  if(req.headers['sec-fetch-site']==='cross-site')return false;
  const origin=req.headers.origin;
  if(!origin)return true;
  const hostUrl=`${req.headers['x-forwarded-proto']==='https'?'https':'http'}://${req.headers.host}`;
  return origin===hostUrl || origin===appOrigin;
};

async function paypalRequest(endpoint,method='GET',data=null){
  const clientId=process.env.PAYPAL_CLIENT_ID, secret=process.env.PAYPAL_CLIENT_SECRET;
  if(!clientId||!secret)throw Error('PayPal credentials are not configured');
  const base=process.env.PAYPAL_ENV==='live'?'https://api-m.paypal.com':'https://api-m.sandbox.paypal.com';
  const tokenResp=await fetch(`${base}/v1/oauth2/token`,{method:'POST',headers:{Authorization:'Basic '+Buffer.from(`${clientId}:${secret}`).toString('base64'),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
  const token=await tokenResp.json();if(!tokenResp.ok)throw Error('PayPal authentication failed');
  const reply=await fetch(base+endpoint,{method,headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json','PayPal-Request-Id':crypto.randomUUID()}, ...(data?{body:JSON.stringify(data)}:{})});
  const result=await reply.json();if(!reply.ok)throw Error(result.message || 'PayPal request failed');return result;
}
const makePublicUrl=(req)=>appOrigin || `${SECURE?'https':'http'}://${req.headers.host}`;
const setSecurityHeaders=(res,req,nonce)=>{
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Referrer-Policy','strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Content-Security-Policy', `default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://www.paypal.com; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; upgrade-insecure-requests`);
  if(SECURE && (req.headers['x-forwarded-proto']==='https'||req.socket.encrypted))res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
};
const escapeHTML=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const canonicalBase=()=>((process.env.SITE_URL||appOrigin||'').replace(/\/$/,'')).replace(/[^-a-zA-Z0-9:/._]/g,'');
const pageDetails=(pathname)=>{
  const site=getSetting('site');const base=site.brand||'Expert in Shopify';
  const obj={title:site.seoTitle||base,desc:site.seoDescription||'',heading:site.heroTitle+' '+site.heroAccent,summary:site.heroDescription};
  if(pathname==='/services'||pathname.startsWith('/services/')){
    const category=pathname.startsWith('/services/')?pathname.split('/')[2]:'';
    const p=['shopify','wix','squarespace','webflow'].includes(category)?category[0].toUpperCase()+category.slice(1):'';
    obj.title=(p?`${p} website packages & pricing`:'Website design services & pricing')+` | ${base}`;
    obj.desc=(p?`Compare ${p} website design packages, deliverables and project timelines.`:'Explore Shopify, Wix, Squarespace and Webflow design packages and transparent pricing.')+' Serving USA, UK, Australia and Canada.';
    obj.heading=p?`${p} website packages`:'Shopify, Wix, Squarespace & Webflow services';
    obj.summary=obj.desc;
  }else if(pathname==='/portfolio'){
    obj.title=`Portfolio — Shopify, Wix, Squarespace & Webflow | ${base}`;
    obj.desc='Browse recent ecommerce and business website projects built for ambitious brands in the USA, UK, Canada and Australia.';
    obj.heading='Website design portfolio';obj.summary=obj.desc;
  }else if(pathname==='/reviews'){
    obj.title=`Client reviews | ${base}`;obj.desc='Read reviews from store owners and brands we have built Shopify, Wix, Squarespace and Webflow websites for.';
    obj.heading='Client reviews';obj.summary=obj.desc;
  }else if(pathname==='/winning-products'){
    obj.title=`Winning products for ecommerce stores | ${base}`;obj.desc='Hand-picked trending products for dropshipping and Shopify stores, with AliExpress suppliers and Amazon comparisons.';
    obj.heading='Winning products';obj.summary=obj.desc;
  }
  return obj;
};
const isIndexable=(p)=>p==='/'||p==='/services'||p==='/portfolio'||p==='/reviews'||p==='/winning-products'||/^\/services\/(shopify|wix|squarespace|webflow)$/.test(p);
const serveDocument=(req,res,p,nonce)=>{
  const index=path.join(root,'dist','index.html');if(!fs.existsSync(index))return false;
  const site=getSetting('site'),d=pageDetails(p),origin=canonicalBase(),canon=origin+(p==='/'?'':p);
  const metaRobots=isIndexable(p)?'index,follow,max-image-preview:large':'noindex,nofollow';
  const schema={ '@context':'https://schema.org', '@type':'ProfessionalService',name:site.brand,description:site.seoDescription,url:origin||undefined,email:site.email,areaServed:[{ '@type':'Country',name:'United States'},{'@type':'Country',name:'United Kingdom'},{'@type':'Country',name:'Australia'},{'@type':'Country',name:'Canada'}],makesOffer:selectServices().filter(s=>s.active).slice(0,12).map(s=>({'@type':'Offer',name:s.title,price:s.price,priceCurrency:getSetting('payment').currency}))};
  const tags=`<meta name="robots" content="${metaRobots}"><meta name="description" content="${escapeHTML(d.desc)}"><meta name="keywords" content="${escapeHTML(site.seoKeywords||'')}"><link rel="canonical" href="${escapeHTML(canon)}"><meta property="og:type" content="website"><meta property="og:site_name" content="${escapeHTML(site.brand)}"><meta property="og:title" content="${escapeHTML(d.title)}"><meta property="og:description" content="${escapeHTML(d.desc)}"><meta property="og:url" content="${escapeHTML(canon)}"><meta name="twitter:card" content="summary_large_image"><script nonce="${nonce}" type="application/ld+json">${JSON.stringify(schema).replace(/</g,'\\u003c')}</script>`;
  const previewItems=p.startsWith('/services') ? selectServices().filter(s=>s.active && (p==='/services'||s.platform.toLowerCase()===p.split('/')[2])).map(s=>`<li><strong>${escapeHTML(s.title)}</strong> — ${escapeHTML(s.platform)} — ${escapeHTML(s.price)} ${escapeHTML(getSetting('payment').currency)}. ${escapeHTML(s.description)}</li>`).join('')
    : p==='/portfolio'? selectProjects().map(project=>`<li><strong>${escapeHTML(project.title)}</strong> — ${escapeHTML(project.platform)}. ${escapeHTML(project.description)}</li>`).join('')
    : selectServices().filter(s=>s.active&&s.featured).slice(0,4).map(s=>`<li>${escapeHTML(s.title)} — ${escapeHTML(s.platform)}</li>`).join('');
  const snippet=isIndexable(p)?`<section class="pre-render-content"><h1>${escapeHTML(d.heading)}</h1><p>${escapeHTML(d.summary)}</p><nav><a href="/services">Services and pricing</a> · <a href="/portfolio">Portfolio</a></nav><ul>${previewItems}</ul></section>`:'';
  const buffer=fs.readFileSync(index,'utf8').replace(/<title>[^<]*<\/title>/,`<title>${escapeHTML(d.title)}</title>`).replace(/<meta name="description"[^>]*>/,'').replace('</head>',tags+'</head>').replace('<div id="root"></div>',`<div id="root">${snippet}</div>`);
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-cache, must-revalidate'});res.end(buffer);return true;
};
const serveFile=(req,res,file,cache=false)=>{
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'};
  if(!fs.existsSync(file)||!fs.statSync(file).isFile())return false;
  const cacheControl=cache?'public,max-age=31536000,immutable':'public,max-age=3600';
  const mime=types[path.extname(file).toLowerCase()]||'application/octet-stream';
  const gzipOk=/\bgzip\b/.test(req.headers['accept-encoding']||'') && /\.(js|css|svg|html)$/.test(file) && fs.statSync(file).size>1000;
  res.writeHead(200,{'content-type':mime,'cache-control':cacheControl,...(gzipOk?{'content-encoding':'gzip','vary':'Accept-Encoding'}:{})});
  if(req.method==='HEAD'){res.end();return true}
  if(gzipOk)pipeline(fs.createReadStream(file),zlib.createGzip({level:6}),res,()=>{});
  else fs.createReadStream(file).pipe(res);
  return true;
};

const uploadAttachment=async(req,res,threadId,sender)=>{
  if(!clientUploadsEnabled)return sendError(res,503,'Image attachments are disabled until ClamAV scanning is configured');
  if(limited(req,'client-image-upload',10,3600000))return sendError(res,429,'Upload limit reached');
  const b=await parseBody(req);const {original,cleaned}=await processImageData(b.data);
  await scanAntivirus(original);
  const fid=id(),storageKey=fid+'.webp',name=str(b.name,100).replace(/[<>\/\\:\x00-\x1f]/g,'').replace(/[^a-zA-Z0-9 ._()-]/g,'_')||'project-image.webp';
  fs.writeFileSync(path.join(privateDir,storageKey),cleaned,{flag:'wx',mode:0o600});
  db.prepare('INSERT INTO attachments(id,conversation_id,sender,filename,storage_key,media_type,bytes) VALUES(?,?,?,?,?,?,?)').run(fid,threadId,sender,name,storageKey,'image/webp',cleaned.length);
  return json(res,201,{id:fid,name,bytes:cleaned.length});
};
const getAttachment=(req,res,threadId,attachmentId)=>{
  const a=db.prepare('SELECT * FROM attachments WHERE id=? AND conversation_id=?').get(attachmentId,threadId);
  if(!a)return sendError(res,404,'Image not found');
  const file=path.join(privateDir,a.storage_key);
  if(!fs.existsSync(file))return sendError(res,404,'Image not found');
  res.writeHead(200,{'content-type':'image/webp','content-disposition':`attachment; filename="project-image-${a.id.slice(0,8)}.webp"`,'cache-control':'private, no-store','x-content-type-options':'nosniff'});
  if(req.method==='HEAD'){res.end();return}
  fs.createReadStream(file).pipe(res);
};
const server=http.createServer(async(req,res)=>{
  const url = new URL(req.url||'/', 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  const method=req.method||'GET';
  const nonce=crypto.randomBytes(16).toString('base64');
  setSecurityHeaders(res,req,nonce);
  try {
    if(pathname.startsWith('/api/')){
      if(['POST','PUT','PATCH','DELETE'].includes(method) && !sameOrigin(req)) return sendError(res,403,'Origin not allowed');
      if(['POST','PUT','PATCH','DELETE'].includes(method) && req.headers['content-type']?.split(';')[0]?.trim()!=='application/json') return sendError(res,415,'JSON content type required');
      if(method==='GET' && pathname==='/api/public')return json(res,200,publicData());
      if(method==='GET' && pathname==='/api/client/me') return json(res,200,{client:safeClient(getClient(req))});
      if(method==='POST' && pathname==='/api/client/register'){
        if(limited(req,'register',6,3600000))return sendError(res,429,'Too many registrations. Try later.');
        const b=await parseBody(req);const name=str(b.name,100),email=str(b.email,200).toLowerCase();
        if(name.length<2||!validEmail(email))return sendError(res,400,'Provide your name and a valid email address');
        if(typeof b.password!=='string'||b.password.length<10||b.password.length>256)return sendError(res,400,'Password must be 10–256 characters');
        if(db.prepare('SELECT 1 FROM clients WHERE email=?').get(email))return sendError(res,409,'An account with this email already exists');
        const salt=crypto.randomBytes(16).toString('hex'),clientId=id();
        db.prepare('INSERT INTO clients(id,name,email,salt,password_hash) VALUES(?,?,?,?,?)').run(clientId,name,email,salt,crypto.scryptSync(b.password,salt,64).toString('hex'));
        startClientSession(res,clientId);notifyConversation(clientId);return json(res,201,{client:{id:clientId,name,email}});
      }
      if(method==='POST' && pathname==='/api/client/login'){
        if(limited(req,'client-login',12,300000))return sendError(res,429,'Too many attempts. Try again later.');
        const b=await parseBody(req),email=str(b.email,200).toLowerCase();
        const c=db.prepare('SELECT * FROM clients WHERE email=?').get(email);
        // Perform a KDF even if the email does not exist to reduce account enumeration via timing.
        const salt=c?.salt||'0'.repeat(32),actual=crypto.scryptSync(typeof b.password==='string'?b.password.slice(0,256):'',salt,64);
        if(!c||!crypto.timingSafeEqual(actual,Buffer.from(c.password_hash,'hex')))return sendError(res,401,'Invalid email or password');
        startClientSession(res,c.id);return json(res,200,{client:safeClient(c)});
      }
      if(method==='POST' && pathname==='/api/client/logout'){
        const token=getCookie(req,'studio_client');if(token)db.prepare('DELETE FROM client_sessions WHERE token_hash=?').run(tokenHash(token));
        clientCookie(res,'');return json(res,200,{ok:true});
      }
      if(method==='GET' && pathname==='/api/client/events'){
        const c=getClient(req);if(!c)return sendError(res,401,'Sign in to view messages');
        return openEvents(req,res,'client',c.id);
      }
      if(pathname.startsWith('/api/client/')){
        const c=getClient(req);if(!c)return sendError(res,401,'Please sign in to your client account');
        if(method==='GET' && pathname==='/api/client/orders')return json(res,200,{orders:db.prepare('SELECT id,service_title,platform,amount,currency,method,status,created_at,updated_at FROM orders WHERE client_id=? ORDER BY created_at DESC').all(c.id)});
        if(method==='GET' && pathname==='/api/client/conversations')return json(res,200,{conversations:conversationsList(false,c.id)});
        if(method==='POST'&&pathname==='/api/client/conversations'){
          if(limited(req,'start-thread',20,3600000))return sendError(res,429,'Try again later');
          if(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE client_id=?').get(c.id).n>=60)return sendError(res,400,'Conversation limit reached');
          const b=await parseBody(req);const subject=str(b.subject,140)||'Project enquiry';let orderId=null;
          if(b.orderId){const o=db.prepare('SELECT id FROM orders WHERE id=? AND client_id=?').get(str(b.orderId,50),c.id);if(!o)return sendError(res,404,'Your order was not found');orderId=o.id}
          const threadId=id();db.prepare('INSERT INTO conversations(id,client_id,order_id,subject) VALUES(?,?,?,?)').run(threadId,c.id,orderId,subject);
          notifyConversation(c.id);return json(res,201,{id:threadId});
        }
        const clientAttachment=pathname.match(/^\/api\/client\/conversations\/([a-z0-9-]+)\/attachments(?:\/([a-f0-9-]+))?$/);
        if(clientAttachment){
          const t=getThread(clientAttachment[1],false,c.id);if(!t)return sendError(res,404,'Conversation not found');
          if(method==='POST' && !clientAttachment[2])return uploadAttachment(req,res,t.id,'client');
          if(method==='GET' && clientAttachment[2])return getAttachment(req,res,t.id,clientAttachment[2]);
        }
        const read=pathname.match(/^\/api\/client\/conversations\/([a-z0-9-]+)\/messages$/);
        if(read){const t=getThread(read[1],false,c.id);if(!t)return sendError(res,404,'Conversation not found');
          if(method==='GET'){if(markRead(t.id,'admin'))notifyConversation(c.id);return json(res,200,{conversation:t,messages:threadMessages(t.id)});}
          if(method==='POST'){
            if(limited(req,'send-client',80,3600000))return sendError(res,429,'Message limit reached');
            const b=await parseBody(req);sendMessage(t.id,'client',b.body,str(b.attachmentId,80)||null);notifyConversation(t.client_id);notifyAsync('Messages','New client inbox message',`Client: ${c.name} (${c.email})\nSubject: ${t.subject}\nMessage: ${str(b.body,800)||'[Image attachment]'}`,c.email);return json(res,201,{ok:true});
          }
        }
        return sendError(res,404,'Client endpoint not found');
      }
      if(method==='GET' && pathname==='/api/admin/events'){
        if(!isAuthed(req))return sendError(res,401,'Administrator login required');
        return openEvents(req,res,'admin');
      }

      if(method==='GET' && pathname==='/api/admin/me')return json(res,200,{authenticated:isAuthed(req)});
      if(method==='POST' && pathname==='/api/admin/login'){
        if(limited(req,'login',12,300000))return sendError(res,429,'Too many login attempts; try later');
        const b=await parseBody(req);const account=db.prepare('SELECT * FROM admin WHERE id=1').get();
        const actual=crypto.scryptSync(str(b.password,500),account.salt,64);
        if(!crypto.timingSafeEqual(actual,Buffer.from(account.password_hash,'hex')))return sendError(res,401,'Incorrect password');
        const token=crypto.randomBytes(32).toString('hex');
        db.prepare('INSERT INTO sessions(token_hash,expires_at) VALUES(?,?)').run(crypto.createHash('sha256').update(token).digest('hex'),Date.now()+7*86400000);
        res.setHeader('Set-Cookie',`studio_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${SECURE?'; Secure':''}`);
        return json(res,200,{ok:true});
      }
      if(method==='POST'&&pathname==='/api/admin/logout'){
        const token=getCookie(req,'studio_session');if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(crypto.createHash('sha256').update(token).digest('hex'));
        res.setHeader('Set-Cookie',`studio_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE?'; Secure':''}`);
        return json(res,200,{ok:true});
      }
      if(method==='POST'&&pathname==='/api/inquiries'){
        if(limited(req,'contact',6,3600000))return sendError(res,429,'Too many messages; please try later');
        const b=await parseBody(req);const name=str(b.name,120),email=str(b.email,200),message=str(b.message,3000);
        if(name.length<2||!validEmail(email)||message.length<10)return sendError(res,400,'Enter a name, valid email and message (10+ characters)');
        db.prepare('INSERT INTO inquiries(id,name,email,phone,service,budget,message) VALUES(?,?,?,?,?,?,?)').run(id(),name,email,str(b.phone,80),str(b.service,100),str(b.budget,100),message);
        notifyAsync('Inquiries','New website inquiry',`From: ${name} (${email})\nService: ${str(b.service,100)}\nMessage: ${message}`,email);
        return json(res,201,{ok:true});
      }
      if(method==='POST'&&pathname==='/api/coupons/check'){
        if(limited(req,'coupon',30,600000))return sendError(res,429,'Too many attempts; try again later');
        const b=await parseBody(req);const service=db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(str(b.serviceId,50));
        if(!service)return sendError(res,404,'Service not found');
        return json(res,200,{ok:true,original:service.price,...applyCoupon(service,b.code)});
      }
      if(method==='POST'&&pathname==='/api/orders'){
        if(limited(req,'order',15,3600000))return sendError(res,429,'Too many checkout attempts; try later');
        const b=await parseBody(req);const service=db.prepare('SELECT * FROM services WHERE id=? AND active=1').get(str(b.serviceId,50));
        if(!service)return sendError(res,404,'Service not found');
        const payment=getSetting('payment');const methodName=str(b.method,30);
        const enabled={paypal:!!(payment.paypalEnabled && process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),payoneer:!!payment.payoneerEnabled,bank:!!payment.bankEnabled};
        if(!enabled[methodName])return sendError(res,400,'This payment option is not available');
        const name=str(b.name,120),email=str(b.email,200);if(name.length<2||!validEmail(email))return sendError(res,400,'Name and valid email are required');
        const c=getClient(req);const deal=applyCoupon(service,b.couponCode);
        if(c&&(c.email!==email||c.name!==name))return sendError(res,400,'Use the name and email from your client account for checkout');
        const orderId=id();db.prepare('INSERT INTO orders(id,service_id,service_title,platform,amount,currency,customer_name,customer_email,customer_phone,notes,method,status,client_id,original_amount,discount_code,discount_amount) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(orderId,service.id,service.title,service.platform,deal.total,payment.currency||'USD',name,email,str(b.phone,80),str(b.notes,2500),methodName,methodName==='paypal'?'awaiting_payment':'awaiting_manual_payment',c?.id||null,service.price,deal.code,deal.discount);
        notifyAsync('Orders','New service order',`Customer: ${name} (${email})\nService: ${service.title}\nAmount: ${deal.total} ${payment.currency||'USD'}${deal.code?` (code ${deal.code}, saved ${deal.discount})`:''}\nMethod: ${methodName}\nOrder: ${orderId}`,email);
        return json(res,201,{id:orderId});
      }
      const orderRoute=pathname.match(/^\/api\/orders\/([a-z0-9-]+)$/);
      if(orderRoute&&method==='GET'){
        const o=db.prepare('SELECT id,service_title,platform,amount,original_amount,discount_code,discount_amount,currency,customer_name,method,status,created_at,transaction_ref FROM orders WHERE id=?').get(orderRoute[1]);
        if(!o)return sendError(res,404,'Order not found');return json(res,200,{order:o,payment:getSetting('payment')});
      }
      const createPP=pathname.match(/^\/api\/orders\/([a-z0-9-]+)\/paypal\/create$/);
      if(createPP&&method==='POST'){
        const o=db.prepare('SELECT * FROM orders WHERE id=?').get(createPP[1]);if(!o||o.method!=='paypal'||o.status!=='awaiting_payment')return sendError(res,400,'PayPal not available for this order');
        // A fresh PayPal approval link can be requested if an earlier attempt was cancelled.
        const origin=makePublicUrl(req);const result=await paypalRequest('/v2/checkout/orders','POST',{
          intent:'CAPTURE',purchase_units:[{reference_id:o.id,custom_id:o.id,description:o.service_title,amount:{currency_code:o.currency,value:o.amount.toFixed(2)}}],
          application_context:{brand_name:getSetting('site').brand||'Expert in Shopify',landing_page:'LOGIN',user_action:'PAY_NOW',return_url:`${origin}/order/${o.id}?paypal=approved`,cancel_url:`${origin}/order/${o.id}?paypal=cancelled`}
        });
        db.prepare('UPDATE orders SET paypal_id=? WHERE id=?').run(result.id,o.id);
        return json(res,200,{approveUrl:result.links?.find(l=>l.rel==='approve')?.href});
      }
      const capturePP=pathname.match(/^\/api\/orders\/([a-z0-9-]+)\/paypal\/capture$/);
      if(capturePP&&method==='POST'){
        const o=db.prepare('SELECT * FROM orders WHERE id=?').get(capturePP[1]);
        if(!o||o.method!=='paypal'||!o.paypal_id)return sendError(res,400,'PayPal payment has not started');
        if(o.status==='paid')return json(res,200,{ok:true,status:'paid'});
        if(o.status!=='awaiting_payment')return sendError(res,409,'Order cannot be captured in this state');
        const result=await paypalRequest(`/v2/checkout/orders/${encodeURIComponent(o.paypal_id)}/capture`,'POST',{});
        const pu=result.purchase_units?.[0];const capture=pu?.payments?.captures?.[0];
        if(result.status!=='COMPLETED'||capture?.status!=='COMPLETED'||pu?.reference_id!==o.id||capture.amount?.currency_code!==o.currency||Number(capture.amount?.value)!==o.amount)
          return sendError(res,409,'PayPal payment not complete or amount mismatch. Contact support.');
        db.prepare("UPDATE orders SET status='paid',transaction_ref=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='awaiting_payment'").run(capture.id,o.id);
        return json(res,200,{ok:true,status:'paid'});
      }
      if(pathname.startsWith('/api/admin/')){
        if(!isAuthed(req))return sendError(res,401,'Administrator login required');
        if(method==='GET'&&pathname==='/api/admin/conversations')return json(res,200,{conversations:conversationsList(true)});
        if(method==='POST'&&pathname==='/api/admin/conversations'){
          const b=await parseBody(req),c=db.prepare('SELECT id FROM clients WHERE id=?').get(str(b.clientId,60));
          if(!c)return sendError(res,404,'Client account not found');
          let orderId=null;
          if(b.orderId){const o=db.prepare('SELECT id FROM orders WHERE id=? AND client_id=?').get(str(b.orderId,60),c.id);if(!o)return sendError(res,404,'Order not linked to client');orderId=o.id}
          const threadId=id();db.prepare('INSERT INTO conversations(id,client_id,order_id,subject) VALUES(?,?,?,?)').run(threadId,c.id,orderId,str(b.subject,140)||'Project discussion');
          notifyConversation(c.id);return json(res,201,{id:threadId});
        }
        const adminAttachment=pathname.match(/^\/api\/admin\/conversations\/([a-z0-9-]+)\/attachments(?:\/([a-f0-9-]+))?$/);
        if(adminAttachment){const t=getThread(adminAttachment[1],true);if(!t)return sendError(res,404,'Conversation not found');
          if(method==='POST'&&!adminAttachment[2])return uploadAttachment(req,res,t.id,'admin');
          if(method==='GET'&&adminAttachment[2])return getAttachment(req,res,t.id,adminAttachment[2]);
        }
        const adminMessages=pathname.match(/^\/api\/admin\/conversations\/([a-z0-9-]+)\/messages$/);
        if(adminMessages){const t=getThread(adminMessages[1],true);if(!t)return sendError(res,404,'Conversation not found');
          if(method==='GET'){if(markRead(t.id,'client'))notifyConversation(t.client_id);return json(res,200,{conversation:t,messages:threadMessages(t.id)});}
          if(method==='POST'){
            if(limited(req,'send-admin',200,3600000))return sendError(res,429,'Message limit reached');
            const b=await parseBody(req);sendMessage(t.id,'admin',b.body,str(b.attachmentId,80)||null);notifyConversation(t.client_id);return json(res,201,{ok:true});
          }
        }
        const linkOrder=pathname.match(/^\/api\/admin\/orders\/([a-z0-9-]+)\/attach-client$/);
        if(linkOrder&&method==='POST'){
          const o=db.prepare('SELECT id,customer_email,client_id FROM orders WHERE id=?').get(linkOrder[1]);if(!o)return sendError(res,404,'Order not found');
          const b=await parseBody(req),c=db.prepare('SELECT id,email FROM clients WHERE id=?').get(str(b.clientId,60));
          if(!c||o.customer_email.toLowerCase()!==c.email)return sendError(res,400,'Client must have the exact same email as the order');
          if(o.client_id&&o.client_id!==c.id)return sendError(res,409,'Order is linked to another account');
          db.prepare('UPDATE orders SET client_id=? WHERE id=?').run(c.id,o.id);return json(res,200,{ok:true});
        }
        if(method==='POST' && pathname==='/api/admin/password'){
          const b=await parseBody(req);const account=db.prepare('SELECT * FROM admin WHERE id=1').get();
          const actual=crypto.scryptSync(str(b.currentPassword,500),account.salt,64);
          if(!crypto.timingSafeEqual(actual,Buffer.from(account.password_hash,'hex')))return sendError(res,403,'Current password is incorrect');
          if(typeof b.newPassword!=='string' || b.newPassword.length<12 || b.newPassword.length>256)return sendError(res,400,'New password must be 12–256 characters');
          const salt=crypto.randomBytes(16).toString('hex');const hash=crypto.scryptSync(b.newPassword,salt,64).toString('hex');
          db.prepare('UPDATE admin SET salt=?,password_hash=? WHERE id=1').run(salt,hash);
          db.prepare('DELETE FROM sessions').run();
          res.setHeader('Set-Cookie',`studio_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${SECURE?'; Secure':''}`);
          return json(res,200,{ok:true,message:'Password changed. Please sign in again.'});
        }
        if(method==='GET'&&pathname==='/api/admin/data')return json(res,200,{notificationsConfigured:!!(process.env.RESEND_API_KEY&&process.env.MAIL_FROM),...publicData(),site:getSetting('site'),services:selectServices(),products:db.prepare('SELECT * FROM products ORDER BY sort,title').all(),coupons:db.prepare('SELECT * FROM coupons ORDER BY rowid DESC').all().map(c=>({...c,uses:activeCouponUses(c.code)})),payment:getSetting('payment'),orders:db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 500').all(),inquiries:db.prepare('SELECT * FROM inquiries ORDER BY created_at DESC LIMIT 500').all(),clients:db.prepare('SELECT id,name,email,created_at FROM clients ORDER BY created_at DESC LIMIT 500').all(),conversations:conversationsList(true)});
        if(method==='PUT'&&pathname==='/api/admin/site'){
          const b=await parseBody(req);const old=getSetting('site');const updated={...old};
          for(const key of Object.keys(settingsDefault)) if(key in b){
            if(key==='platformDescriptions')updated[key]=Object.fromEntries(['Shopify','Wix','Squarespace','Webflow'].map(p=>[p,str(b[key]?.[p]||'',350)]));
            else if(key==='stats'||key==='steps')updated[key]=Array.isArray(b[key])?b[key].slice(0,6).map(v=>({...(key==='steps'?{title:str(v.title,100),text:str(v.text,500)}:{value:str(v.value,40),label:str(v.label,100)})})):old[key];
            else if(['cursorEffect','notifyInquiries','notifyOrders','notifyMessages'].includes(key))updated[key]=!!b[key];
            // Page text overrides: short alphanumeric keys only; empty values fall back to the built-in default text.
            else if(key==='texts')updated[key]=b[key]&&typeof b[key]==='object'&&!Array.isArray(b[key])?Object.fromEntries(Object.entries(b[key]).filter(([k,v])=>/^[a-zA-Z0-9]{1,60}$/.test(k)&&str(v,1000)).slice(0,400).map(([k,v])=>[k,str(v,1000)])):{};
            else updated[key]=str(b[key],2000);
          }
          for(const color of ['accent','accentAlt','darkColor','lightColor','textColor','cardColor'])if(!/^#[0-9a-f]{6}$/i.test(updated[color]))return sendError(res,400,`${color} must be a 6-digit hex color`);
          if(updated.notificationEmail && !validEmail(updated.notificationEmail))return sendError(res,400,'Enter a valid notification email');
          setSetting('site',updated);return json(res,200,{ok:true,site:updated});
        }
        if(method==='PUT'&&pathname==='/api/admin/payment'){
          const b=await parseBody(req);const updated={...getSetting('payment')};
          for(const key of Object.keys(paymentDefault))if(key in b)updated[key]=(key.endsWith('Enabled')?!!b[key]:str(b[key],700));
          if(!['USD','EUR','GBP','AUD','CAD'].includes(updated.currency))return sendError(res,400,'Unsupported currency');
          if(!validHttpLink(updated.payoneerLink))return sendError(res,400,'Payoneer link must use HTTPS');
          setSetting('payment',updated);return json(res,200,{ok:true,payment:updated});
        }
        if(method==='POST'&&pathname==='/api/admin/upload'){
          if(limited(req,'upload-admin',30,3600000))return sendError(res,429,'Too many uploads');
          const b=await parseBody(req),{cleaned}=await processImageData(b.data);
          const filename=`${id()}.webp`;
          fs.writeFileSync(path.join(uploadsDir,filename),cleaned,{mode:0o644,flag:'wx'});
          return json(res,201,{url:'/uploads/'+filename,size:cleaned.length});
        }
        for (const table of ['services','projects','partners','reviews','products','coupons']){
          const base='/api/admin/'+table;
          if(pathname===base&&method==='POST'){
            const entry=normalizeEntity(table,await parseBody(req));const keys=allowedEntity[table];
            db.prepare(`INSERT INTO ${table}(id,${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',') .replace(/^/,'?,')})`).run(id(),...keys.map(k=>k==='features'?JSON.stringify(entry[k]):entry[k]??(k==='sort'?0:k==='active'?1:k==='featured'?0:'')));
            return json(res,201,{ok:true});
          }
          const match=pathname.match(new RegExp('^'+base+'/([a-z0-9-]+)$'));
          if(match&&method==='PUT'){
            const old=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(match[1]);if(!old)return sendError(res,404,'Entry not found');
            if(table==='services')old.features=JSON.parse(old.features);
            const entry=normalizeEntity(table,await parseBody(req),old);const keys=allowedEntity[table];
            db.prepare(`UPDATE ${table} SET ${keys.map(k=>k+'=?').join(',')} WHERE id=?`).run(...keys.map(k=>k==='features'?JSON.stringify(entry[k]):entry[k]),match[1]);return json(res,200,{ok:true});
          }
          if(match&&method==='DELETE'){
            db.prepare(`DELETE FROM ${table} WHERE id=?`).run(match[1]);return json(res,200,{ok:true});
          }
        }
        const orderPatch=pathname.match(/^\/api\/admin\/orders\/([a-z0-9-]+)$/);
        if(orderPatch&&method==='PATCH'){
          const b=await parseBody(req);if(!['awaiting_payment','awaiting_manual_payment','paid','in_progress','complete','cancelled','refunded'].includes(b.status))return sendError(res,400,'Invalid order status');
          db.prepare('UPDATE orders SET status=?,transaction_ref=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(b.status,str(b.transaction_ref,200),orderPatch[1]);const recipient=db.prepare('SELECT client_id FROM orders WHERE id=?').get(orderPatch[1]);if(recipient?.client_id)notifyConversation(recipient.client_id);return json(res,200,{ok:true});
        }
        const inqPatch=pathname.match(/^\/api\/admin\/inquiries\/([a-z0-9-]+)$/);
        if(inqPatch&&method==='PATCH'){
          const b=await parseBody(req);if(!['new','read','replied','archived'].includes(b.status))return sendError(res,400,'Invalid inquiry status');
          db.prepare('UPDATE inquiries SET status=? WHERE id=?').run(b.status,inqPatch[1]);return json(res,200,{ok:true});
        }
      }
      return sendError(res,404,'Endpoint not found');
    }
    if(method!=='GET'&&method!=='HEAD')return sendError(res,405,'Method not allowed');
    if(pathname==='/robots.txt'){
      res.writeHead(200,{'content-type':'text/plain; charset=utf-8','cache-control':'public,max-age=3600'});
      res.end(`User-agent: *\nDisallow: /admin\nDisallow: /account\nDisallow: /checkout\nDisallow: /order\nDisallow: /login\nDisallow: /register\nDisallow: /api/\nSitemap: ${canonicalBase()}/sitemap.xml\n`);return;
    }
    if(pathname==='/sitemap.xml'){
      const base=canonicalBase(),routes=['/','/services','/portfolio','/reviews','/winning-products',...['shopify','wix','squarespace','webflow'].map(x=>'/services/'+x)];
      res.writeHead(200,{'content-type':'application/xml; charset=utf-8','cache-control':'public,max-age=3600'});
      res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+routes.map(p=>`<url><loc>${escapeHTML(base+p)}</loc></url>`).join('')+'</urlset>');return;
    }
    if(pathname.startsWith('/uploads/')){
      const name=path.basename(pathname);if(name!==pathname.slice('/uploads/'.length)||!/^[-a-zA-Z0-9_.]+$/.test(name))return sendError(res,400,'Bad file name');
      if(serveFile(req,res,path.join(uploadsDir,name),false))return;
      return sendError(res,404,'Image not found');
    }
    const dist=path.join(root,'dist');
    if(/^\/assets\/[a-zA-Z0-9_.-]+$/.test(pathname)&&serveFile(req,res,path.join(dist,pathname),true))return;
    if(pathname==='/favicon.svg'&&serveFile(req,res,path.join(dist,'favicon.svg'),false))return;
    if(serveDocument(req,res,pathname,nonce))return;
    res.writeHead(200,{'content-type':'text/plain; charset=utf-8'});res.end('API is running. Open http://localhost:5173 after npm run dev.');
  }catch(err){console.error('Server error:',err);return sendError(res,err.status||500,err.status?err.message: (SECURE?'A server error occurred':err.message));}
});
server.listen(PORT,()=>console.log(`Portfolio API ready on http://localhost:${PORT}`));
