import crypto from 'node:crypto';
import path from 'node:path';
import { Pool } from 'pg';

const APP = 'DADDYS STORE';
const MAX_UPLOAD = 25 * 1024 * 1024;
const COOKIE_SECURE = true;
let pool;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const token = (n=24) => crypto.randomBytes(n).toString('base64url');
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const moneyPaise = value => { const n=Number(value); if(!Number.isFinite(n)||n<0||n>10000000) fail(422,'Invalid price'); return Math.round(n*100); };
const safeInt = (v,d=0,min=0,max=100000) => { const n=Number.parseInt(v,10); return Number.isFinite(n)?Math.max(min,Math.min(max,n)):d; };
const cleanEmail = s => String(s||'').trim().toLowerCase();
const validEmail = s => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s||''));
const cleanPhone = s => String(s||'').replace(/\D/g,'');
const safeEq = (a,b) => { const aa=Buffer.from(String(a)); const bb=Buffer.from(String(b)); return aa.length===bb.length && crypto.timingSafeEqual(aa,bb); };

function db() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured. Add the Supabase transaction-pooler connection string in Netlify environment variables.');
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000, ssl: { rejectUnauthorized: false } });
  return pool;
}
async function q(sql, params=[]) { return (await db().query(sql,params)).rows; }
async function one(sql, params=[]) { return (await q(sql,params))[0] || null; }

function json(data,status=200,headers={}) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...headers } });
}
async function bodyJson(req) { try { return await req.json(); } catch { fail(400,'Invalid JSON body'); } }
function cookieMap(req) {
  const out={}; for (const part of (req.headers.get('cookie')||'').split(';')) { const i=part.indexOf('='); if(i>0) out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim()); } return out;
}
function sessionSign(role,userId,ttl=12*60*60) {
  const secret=process.env.APP_SECRET||''; if(secret.length<32) throw new Error('APP_SECRET must be at least 32 random characters.');
  const payload=`${role}.${userId}.${Math.floor(Date.now()/1000)+ttl}`;
  const sig=crypto.createHmac('sha256',secret).update(payload).digest('hex'); return `${payload}.${sig}`;
}
function sessionRead(req,role) {
  const raw=cookieMap(req)[role==='admin'?'daddy_admin':'daddy_customer']; const secret=process.env.APP_SECRET||'';
  if(!raw||secret.length<32) return null;
  const p=raw.split('.'); if(p.length!==4) return null;
  const [r,uid,exp,sig]=p; const payload=`${r}.${uid}.${exp}`;
  const expected=crypto.createHmac('sha256',secret).update(payload).digest('hex');
  if(r!==role||Number(exp)<Math.floor(Date.now()/1000)||!safeEq(sig,expected)) return null;
  return uid;
}
const cookieHeader=(name,value,ttl)=>`${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${ttl}; HttpOnly; Secure; SameSite=Strict`;
const clearCookie=(name)=>`${name}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
function requireMutation(req) {
  if(req.headers.get('x-requested-with')!=='DADDYS-STORE') fail(403,'Invalid request origin');
  const origin=req.headers.get('origin');
  const host=req.headers.get('x-forwarded-host')||req.headers.get('host')||'';
  if(origin) { try { if(new URL(origin).host!==host) fail(403,'Cross-origin request blocked'); } catch { fail(403,'Cross-origin request blocked'); } }
}
function requireAdmin(req) { const uid=sessionRead(req,'admin'); if(!uid) fail(401,'Admin login required'); return uid; }
function currentCustomer(req) { return sessionRead(req,'customer'); }
async function rate(req,scope,limit,seconds) {
  const ip=req.headers.get('x-nf-client-connection-ip')||req.headers.get('client-ip')||'unknown';
  const key=sha(`${scope}:${ip}`);
  const row=await one(`insert into public.api_rate_limits(rate_key,window_started,attempts) values($1,now(),1)
    on conflict(rate_key) do update set
      window_started=case when public.api_rate_limits.window_started < now()-($2::text||' seconds')::interval then now() else public.api_rate_limits.window_started end,
      attempts=case when public.api_rate_limits.window_started < now()-($2::text||' seconds')::interval then 1 else public.api_rate_limits.attempts+1 end
    returning attempts`,[key,seconds]);
  if(row && Number(row.attempts)>limit) fail(429,'Too many requests. Please try again later.');
}
async function audit(adminId,action,entity,entityId='',detail='') {
  await q('insert into public.audit_logs(admin_id,action,entity,entity_id,detail) values($1,$2,$3,$4,$5)',[adminId,action,entity,String(entityId||''),String(detail||'').slice(0,1000)]);
}
async function setting(key, fallback={}) {
  const r=await one('select value_json from public.settings where key=$1',[key]); return r?.value_json ?? fallback;
}
async function writeSetting(key,value) {
  await q(`insert into public.settings(key,value_json,updated_at) values($1,$2::jsonb,now())
    on conflict(key) do update set value_json=excluded.value_json,updated_at=now()`,[key,JSON.stringify(value)]);
}
function accountDict(row, includePrivate=false) {
  if(!row) return null;
  const out={...row};
  out.inventory=out.inventory_json||{}; out.gallery=out.gallery_json||[]; out.glacier_images=out.glacier_images_json||{};
  delete out.inventory_json; delete out.gallery_json; delete out.glacier_images_json;
  out.price=Number(out.price_paise||0)/100; out.featured=!!out.featured; out.verified=!!out.verified;
  if(!includePrivate) { delete out.seller_name; delete out.seller_submission_id; }
  return out;
}
function catalogDict(row) { const out={...row,metadata:row.metadata_json||{}}; delete out.metadata_json; return out; }
function slugify(value) { const base=String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,70)||'listing'; return `${base}-${crypto.randomBytes(3).toString('hex')}`; }
function passwordHash(password) { const salt=crypto.randomBytes(16); const digest=crypto.pbkdf2Sync(password,salt,310000,32,'sha256'); return `pbkdf2_sha256$${salt.toString('hex')}$${digest.toString('hex')}`; }
function verifyPassword(password,encoded) { try { const [scheme,saltHex,digestHex]=String(encoded).split('$'); if(scheme!=='pbkdf2_sha256') return false; const d=crypto.pbkdf2Sync(password,Buffer.from(saltHex,'hex'),310000,32,'sha256').toString('hex'); return safeEq(d,digestHex); } catch { return false; } }
function validateAccount(d) {
  if(!d||String(d.title||'').trim().length<3||String(d.title).length>150) fail(422,'Account title must be 3–150 characters');
  if(String(d.sku||'').trim().length<2||String(d.sku).length>50) fail(422,'SKU must be 2–50 characters');
  if(!['draft','available','reserved','sold'].includes(d.status||'draft')) fail(422,'Invalid account status');
  const out={title:String(d.title).trim(),sku:String(d.sku).trim().toUpperCase(),description:String(d.description||'').slice(0,5000),price_paise:moneyPaise(d.price),status:d.status||'draft',featured:!!d.featured,verified:!!d.verified,
    account_level:safeInt(d.account_level,1,1,100),mythic_count:safeInt(d.mythic_count,0,0,10000),legendary_count:safeInt(d.legendary_count,0,0,10000),xsuit_count:safeInt(d.xsuit_count,0,0,1000),gun_labs:safeInt(d.gun_labs,0,0,10000),glacier_level:safeInt(d.glacier_level,0,0,7),rp_level:safeInt(d.rp_level,0,0,100),
    inventory_json:JSON.stringify(d.inventory&&typeof d.inventory==='object'?d.inventory:{}),gallery_json:JSON.stringify(Array.isArray(d.gallery)?d.gallery.slice(0,40):[]),glacier_images_json:JSON.stringify(d.glacier_images&&typeof d.glacier_images==='object'?d.glacier_images:{}),video_url:String(d.video_url||'').slice(0,1000),catalog_item_ids:Array.isArray(d.catalog_item_ids)?d.catalog_item_ids.slice(0,300):[]};
  return out;
}
function validateCatalog(d) {
  if(String(d.name||'').length<1||String(d.name).length>150||String(d.category||'').length<2||String(d.category).length>60) fail(422,'Catalog name or category is invalid');
  return {name:String(d.name),category:String(d.category),rarity:String(d.rarity||''),image_url:String(d.image_url||''),description:String(d.description||''),metadata_json:JSON.stringify(d.metadata&&typeof d.metadata==='object'?d.metadata:{}),active:d.active!==false};
}
function validateUc(d) {
  if(String(d.sku||'').length<2||String(d.name||'').length<2||Number(d.uc_amount)<=0) fail(422,'UC package details are invalid');
  return {sku:String(d.sku).toUpperCase(),name:String(d.name),uc_amount:safeInt(d.uc_amount,0,1,1000000),price_paise:moneyPaise(d.price),description:String(d.description||''),active:d.active!==false,sort_order:safeInt(d.sort_order,0,0,10000)};
}
async function storageUpload(bucket,objectPath,bytes,contentType) {
  const base=process.env.SUPABASE_URL; const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  if(!base||!key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be configured.');
  const url=`${base.replace(/\/$/,'')}/storage/v1/object/${bucket}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
  const r=await fetch(url,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':contentType,'x-upsert':'false'},body:bytes});
  if(!r.ok) { const t=await r.text(); throw new HttpError(502,`Supabase Storage upload failed (${r.status}): ${t.slice(0,200)}`); }
  if(bucket==='daddys-store-media') return `${base.replace(/\/$/,'')}/storage/v1/object/public/${bucket}/${objectPath.split('/').map(encodeURIComponent).join('/')}`;
  return objectPath;
}
async function signedStorageUrl(bucket,objectPath,expiresIn=3600) {
  const base=process.env.SUPABASE_URL; const key=process.env.SUPABASE_SERVICE_ROLE_KEY;
  const signed=await fetch(`${base.replace(/\/$/,'')}/storage/v1/object/sign/${bucket}/${objectPath.split('/').map(encodeURIComponent).join('/')}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({expiresIn})});
  const data=await signed.json().catch(()=>({})); if(!signed.ok||!data.signedURL) throw new HttpError(502,'Could not create a temporary signed media link.');
  return data.signedURL.startsWith('http')?data.signedURL:`${base.replace(/\/$/,'')}/storage/v1${data.signedURL}`;
}
async function promoteSellerProof(url) {
  const m=String(url||'').match(/^\/api\/sellers\/proof\/([A-Za-z0-9._-]+)$/); if(!m) return url;
  const base=process.env.SUPABASE_URL; const key=process.env.SUPABASE_SERVICE_ROLE_KEY; const name=m[1];
  const response=await fetch(`${base.replace(/\/$/,'')}/storage/v1/object/daddys-seller-proof/${encodeURIComponent(name)}`,{headers:{apikey:key,Authorization:`Bearer ${key}`}});
  if(!response.ok) throw new HttpError(502,'Could not promote seller proof media during approval.');
  const bytes=Buffer.from(await response.arrayBuffer()); const ext=path.extname(name); const type={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp'}[ext]||'application/octet-stream';
  const publicName=`seller-approved-${crypto.randomBytes(12).toString('hex')}${ext}`;
  return await storageUpload('daddys-store-media',publicName,bytes,type);
}
async function uploadFromRequest(req,kind,adminId=null) {
  const form=await req.formData(); const file=form.get('file');
  if(!file||typeof file.arrayBuffer!=='function') fail(400,'Choose a file to upload');
  const name=String(file.name||'upload').toLowerCase(); const ext=path.extname(name);
  const map={'.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.mp4':'video/mp4','.webm':'video/webm'};
  const seller=kind==='seller';
  if(!map[ext]||file.type!==map[ext]||(seller&&!['.jpg','.jpeg','.png','.webp'].includes(ext))) fail(415,seller?'Upload JPG, PNG or WEBP image proof only':'Allowed file types: jpg, png, webp, gif, mp4, webm');
  const max=seller?10*1024*1024:MAX_UPLOAD; if(file.size>max) fail(413,seller?'Each seller proof image must be 10 MB or smaller':'File is larger than 25 MB');
  const bytes=Buffer.from(await file.arrayBuffer());
  const sigs={'.jpg':Buffer.from([0xff,0xd8,0xff]),'.jpeg':Buffer.from([0xff,0xd8,0xff]),'.png':Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),'.webp':Buffer.from('RIFF'),'.gif':[Buffer.from('GIF87a'),Buffer.from('GIF89a')],'.webm':Buffer.from([0x1a,0x45,0xdf,0xa3])};
  const sig=sigs[ext]; const valid=Array.isArray(sig)?sig.some(s=>bytes.subarray(0,s.length).equals(s)):ext==='.mp4'?(bytes.length>12&&bytes.subarray(4,8).toString()==='ftyp'):bytes.subarray(0,sig.length).equals(sig);
  if(!valid) fail(415,'Invalid file contents');
  const filename=`${crypto.randomBytes(16).toString('hex')}${ext}`;
  const bucket=seller?'daddys-seller-proof':'daddys-store-media';
  const stored=await storageUpload(bucket,filename,bytes,file.type);
  const url=seller?`/api/sellers/proof/${filename}`:stored;
  if(adminId) await audit(adminId,'upload','media',filename);
  return {url,filename,size:bytes.length};
}
async function sendEmail(to,subject,textBody,htmlBody='') {
  const key=process.env.RESEND_API_KEY; const from=process.env.EMAIL_FROM||process.env.SMTP_FROM;
  try {
    if(key&&from) {
      const r=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({from,to:[to],subject,text:textBody,html:htmlBody||undefined})});
      return r.ok;
    }
    if(process.env.SMTP_HOST&&process.env.SMTP_USER&&process.env.SMTP_PASSWORD&&from) {
      const nodemailer=(await import('nodemailer')).default;
      const transporter=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:Number(process.env.SMTP_PORT||587)===465,auth:{user:process.env.SMTP_USER,pass:process.env.SMTP_PASSWORD}});
      await transporter.sendMail({from,to,subject,text:textBody,html:htmlBody||undefined}); return true;
    }
  } catch (error) { console.error('Email delivery failed:',error?.message||error); }
  return false;
}
async function handlePriceDrop(accountId,oldPrice,newPrice,title) {
  if(Number(newPrice)>=Number(oldPrice)) return;
  const alerts=await q('select id,email from public.price_alerts where account_id=$1 and active=true and target_price_paise<$2 and target_price_paise>=$3',[accountId,oldPrice,newPrice]);
  for(const a of alerts) {
    const message=`Price drop: ${title} is now ₹${(Number(newPrice)/100).toLocaleString('en-IN')}. Previous price: ₹${(Number(oldPrice)/100).toLocaleString('en-IN')}.`;
    const sent=await sendEmail(a.email,'DADDYS STORE price drop alert',message);
    await q('insert into public.alert_events(email,account_id,message,sent) values($1,$2,$3,$4)',[a.email,accountId,message,sent]);
    if(sent) await q('update public.price_alerts set active=false where id=$1',[a.id]);
  }
}
function authLink(route,t) { return `${(process.env.PUBLIC_BASE_URL||'').replace(/\/$/,'')}/#${route}/${t}`; }
async function issueAuthToken(uid,purpose,ttl) {
  const raw=token(32); await q('delete from public.auth_tokens where user_id=$1 and purpose=$2',[uid,purpose]);
  await q('insert into public.auth_tokens(token_hash,user_id,purpose,expires_at) values($1,$2,$3,now()+($4::text||\' seconds\')::interval)',[sha(raw),uid,purpose,ttl]); return raw;
}
async function consumeAuthToken(raw,purpose) {
  const row=await one('select user_id from public.auth_tokens where token_hash=$1 and purpose=$2 and used_at is null and expires_at>now()',[sha(raw),purpose]);
  if(!row) return null; await q('update public.auth_tokens set used_at=now() where token_hash=$1',[sha(raw)]); return row.user_id;
}
function accountInsertSql() { return `insert into public.accounts(slug,sku,title,description,price_paise,status,featured,verified,account_level,mythic_count,legendary_count,xsuit_count,gun_labs,glacier_level,rp_level,inventory_json,gallery_json,glacier_images_json,video_url,created_at,updated_at)
values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,now(),now()) returning id,slug`; }
async function linkCatalog(accountId,cids) {
  const client=await db().connect();
  try {
    await client.query('begin');
    await client.query('delete from public.account_items where account_id=$1',[accountId]);
    if(cids.length) await client.query('insert into public.account_items(account_id,catalog_item_id) select $1,c.id from unnest($2::uuid[]) as selected(id) join public.catalog_items c on c.id=selected.id on conflict(account_id,catalog_item_id) do nothing',[accountId,cids]);
    await client.query('commit');
  } catch(error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

async function handle(req) {
  const u=new URL(req.url); let p=u.pathname;
  const marker='/.netlify/functions/api'; if(p.startsWith(marker)) p='/api'+p.slice(marker.length); else if(!p.startsWith('/api/')) p='/api'+(p==='/'?'':'/'+p.replace(/^\//,''));
  const method=req.method.toUpperCase(); const parts=p.split('/').filter(Boolean).slice(1); // remove api
  const [a,b,c]=parts;
  if(p==='/api/health'&&method==='GET') return json({status:'ok',service:APP,time:now()});
  if(p==='/api/public/config'&&method==='GET') {
    const [store,payments,policies]=await Promise.all([setting('store',{}),setting('payments',{}),setting('policies',{})]);
    const safe={}; for(const k of ['upi_enabled','upi_id','payee_name','qr_image','whatsapp_enabled','telegram_enabled','default_method','instructions']) if(k in payments) safe[k]=payments[k];
    return json({store,payments:safe,account_sales_enabled:policies.account_sales_enabled!==false});
  }

  // ADMIN AUTH
  if(p==='/api/admin/login'&&method==='POST') {
    requireMutation(req); await rate(req,'admin-login',8,900); const d=await bodyJson(req);
    const row=await one('select * from public.admins where username=$1',[String(d.username||'')]);
    if(!row||!verifyPassword(String(d.password||''),row.password_hash)) fail(401,'Invalid username or password');
    await q('update public.admins set last_login=now() where id=$1',[row.id]);
    return json({ok:true,username:row.username},200,{'Set-Cookie':cookieHeader('daddy_admin',sessionSign('admin',row.id),12*3600)});
  }
  if(p==='/api/admin/me'&&method==='GET') { const uid=requireAdmin(req); const r=await one('select id,username,last_login from public.admins where id=$1',[uid]); if(!r) fail(401,'Admin not found'); return json(r); }
  if(p==='/api/admin/logout'&&method==='POST') { requireMutation(req); requireAdmin(req); return json({ok:true},200,{'Set-Cookie':clearCookie('daddy_admin')}); }
  if(p==='/api/admin/change-password'&&method==='POST') {
    requireMutation(req); const uid=requireAdmin(req); const d=await bodyJson(req); const r=await one('select password_hash from public.admins where id=$1',[uid]);
    if(!r||!verifyPassword(String(d.current_password||''),r.password_hash)) fail(401,'Current password is incorrect');
    if(String(d.new_password||'').length<14) fail(422,'New password must be at least 14 characters');
    await q('update public.admins set password_hash=$1 where id=$2',[passwordHash(d.new_password),uid]); await audit(uid,'password_change','admin',uid);
    return json({ok:true,message:'Admin password changed. Sign in again using the new password.'},200,{'Set-Cookie':clearCookie('daddy_admin')});
  }

  // CUSTOMER AUTH
  if(p==='/api/auth/register'&&method==='POST') {
    requireMutation(req); await rate(req,'customer-register',5,3600); const d=await bodyJson(req); const email=cleanEmail(d.email);
    if(!validEmail(email)||String(d.name||'').trim().length<2||String(d.password||'').length<12) fail(422,'Enter a valid name, email and password of at least 12 characters');
    let user=await one('select id,email_verified from public.users where email=$1',[email]); let uid=null;
    if(user) { if(!user.email_verified) uid=user.id; }
    else { const created=await one('insert into public.users(name,email,phone,password_hash) values($1,$2,$3,$4) returning id',[String(d.name).trim(),email,String(d.phone||'').slice(0,30),passwordHash(d.password)]); uid=created.id; }
    if(uid) {
      const t=await issueAuthToken(uid,'verify_email',86400); const link=authLink('verify-email',t);
      const sent=await sendEmail(email,'Verify your DADDYS STORE account',`Thanks for creating a DADDYS STORE account. Verify your email within 24 hours: ${link}`,`<p>Thanks for creating a DADDYS STORE account.</p><p><a href="${link}">Verify your email</a> within 24 hours.</p>`);
      return json({ok:true,verification_required:true,message:sent?'Account created. Check your email for the verification link.':'Account created, but verification email could not be sent. Configure RESEND_API_KEY and EMAIL_FROM in Netlify, then request a new link.'},202);
    }
    return json({ok:true,verification_required:true,message:'If this address can be registered, a verification email will be sent.'},202);
  }
  if(p==='/api/auth/resend-verification'&&method==='POST') {
    requireMutation(req); await rate(req,'resend-verification',3,3600); const d=await bodyJson(req); const email=cleanEmail(d.email); const r=await one('select id,email_verified from public.users where email=$1',[email]);
    if(r&&!r.email_verified) { const t=await issueAuthToken(r.id,'verify_email',86400); const link=authLink('verify-email',t); await sendEmail(email,'Verify your DADDYS STORE account',`Verify your email: ${link}`,`<p><a href="${link}">Verify your email</a></p>`); }
    return json({ok:true,message:'If this account needs verification, a new email will be sent.'});
  }
  if(p==='/api/auth/verify-email'&&method==='POST') {
    requireMutation(req); const d=await bodyJson(req); const uid=await consumeAuthToken(d.token,'verify_email'); if(!uid) fail(400,'Verification link is invalid, expired or already used. Request a new link.');
    await q('update public.users set email_verified=true where id=$1',[uid]); return json({ok:true,message:'Email verified successfully.'},200,{'Set-Cookie':cookieHeader('daddy_customer',sessionSign('customer',uid,14*86400),14*86400)});
  }
  if(p==='/api/auth/forgot-password'&&method==='POST') {
    requireMutation(req); await rate(req,'forgot-password',4,3600); const d=await bodyJson(req); const email=cleanEmail(d.email); const r=await one('select id,email_verified from public.users where email=$1',[email]);
    if(r?.email_verified) { const t=await issueAuthToken(r.id,'password_reset',3600); const link=authLink('reset-password',t); await sendEmail(email,'Reset your DADDYS STORE password',`Reset your password within one hour: ${link}`,`<p><a href="${link}">Reset your password</a> within one hour.</p>`); }
    return json({ok:true,message:'If a verified account exists for that email, a password reset link will be sent.'});
  }
  if(p==='/api/auth/reset-password'&&method==='POST') {
    requireMutation(req); await rate(req,'reset-password',5,3600); const d=await bodyJson(req); if(String(d.new_password||'').length<12) fail(422,'Password must be at least 12 characters');
    const uid=await consumeAuthToken(d.token,'password_reset'); if(!uid) fail(400,'Password reset link is invalid, expired or already used.');
    await q('update public.users set password_hash=$1 where id=$2',[passwordHash(d.new_password),uid]); await q('delete from public.auth_tokens where user_id=$1',[uid]); return json({ok:true,message:'Password updated. Sign in with your new password.'});
  }
  if(p==='/api/auth/login'&&method==='POST') {
    requireMutation(req); await rate(req,'customer-login',10,900); const d=await bodyJson(req); const email=cleanEmail(d.username); const r=await one('select * from public.users where email=$1',[email]);
    if(!r||!verifyPassword(String(d.password||''),r.password_hash)) fail(401,'Invalid email or password'); if(!r.email_verified) fail(403,'Please verify your email before signing in. Use Resend verification link.');
    return json({ok:true,name:r.name,email:r.email},200,{'Set-Cookie':cookieHeader('daddy_customer',sessionSign('customer',r.id,14*86400),14*86400)});
  }
  if(p==='/api/auth/me'&&method==='GET') {
    const uid=currentCustomer(req); if(!uid) return json({authenticated:false}); const r=await one('select id,name,email,phone from public.users where id=$1',[uid]); return json({authenticated:!!r,user:r||null});
  }
  if(p==='/api/auth/logout'&&method==='POST') { requireMutation(req); return json({ok:true},200,{'Set-Cookie':clearCookie('daddy_customer')}); }

  // PUBLIC CATALOG
  if(p==='/api/accounts'&&method==='GET') {
    const rows=await q("select * from public.accounts where status='available'"); let items=rows.map(x=>accountDict(x)); const query=(u.searchParams.get('q')||'').toLowerCase();
    if(query) items=items.filter(x=>(x.title+' '+x.sku+' '+x.description+' '+JSON.stringify(x.inventory||{})).toLowerCase().includes(query));
    const min=u.searchParams.has('min_price')?Number(u.searchParams.get('min_price')):null, max=u.searchParams.has('max_price')?Number(u.searchParams.get('max_price')):null;
    if(min!==null) items=items.filter(x=>x.price>=min); if(max!==null) items=items.filter(x=>x.price<=max);
    for(const [param,key] of [['glacier','glacier_level'],['xsuits','xsuit_count'],['mythics','mythic_count'],['gun_labs','gun_labs']]) if(u.searchParams.has(param)) items=items.filter(x=>Number(x[key]||0)>=Number(u.searchParams.get(param)));
    if(u.searchParams.has('featured')) items=items.filter(x=>x.featured===(u.searchParams.get('featured')==='true'));
    const sort=u.searchParams.get('sort')||'newest'; items.sort((x,y)=>sort==='price_asc'?x.price-y.price:sort==='price_desc'?y.price-x.price:sort==='mythics'?y.mythic_count-x.mythic_count:sort==='views'?Number(y.views)-Number(x.views):String(y.created_at).localeCompare(String(x.created_at)));
    return json({items,count:items.length});
  }
  if(a==='accounts'&&b&&method==='GET') {
    const r=await one("select * from public.accounts where slug=$1 and status='available'",[b]); if(!r) fail(404,'Account not found'); await q('select public.bump_account_views($1)',[r.id]);
    const [fresh,linked]=await Promise.all([one('select * from public.accounts where id=$1',[r.id]),q('select c.*,ai.upgrade_level,ai.quantity from public.account_items ai join public.catalog_items c on c.id=ai.catalog_item_id where ai.account_id=$1 and c.active=true order by c.category,c.name',[r.id])]);
    return json({...accountDict(fresh),catalog_items:linked.map(c=>catalogDict(c))});
  }
  if(p==='/api/armory'&&method==='GET') {
    const rows=await q('select * from public.catalog_items where active=true order by category,name'); let items=rows.map(catalogDict); const category=u.searchParams.get('category')||'', query=(u.searchParams.get('q')||'').toLowerCase();
    if(category) items=items.filter(x=>x.category.toLowerCase()===category.toLowerCase()); if(query) items=items.filter(x=>(x.name+' '+x.category+' '+x.description).toLowerCase().includes(query));
    for(const item of items) { const linked=await q("select a.slug,a.title,a.price_paise from public.account_items ai join public.accounts a on a.id=ai.account_id where ai.catalog_item_id=$1 and a.status='available'",[item.id]); item.accounts=linked.map(x=>({slug:x.slug,title:x.title,price:Number(x.price_paise)/100})); }
    const cats=await q('select distinct category from public.catalog_items where active=true order by category'); return json({items,categories:cats.map(x=>x.category),count:items.length});
  }
  if(p==='/api/uc-packages'&&method==='GET') { const rows=await q('select id,sku,name,uc_amount,price_paise,description from public.uc_packages where active=true order by sort_order,uc_amount'); return json({items:rows.map(x=>({...x,price:Number(x.price_paise)/100}))}); }

  // SELLER SUBMISSIONS
  if(a==='sellers'&&b==='proof'&&c&&method==='GET') {
    requireAdmin(req); if(!/^[A-Za-z0-9._-]{6,100}$/.test(c)) fail(404,'Proof image not found');
    const url=await signedStorageUrl('daddys-seller-proof',c,3600); return new Response(null,{status:302,headers:{Location:url,'Cache-Control':'private, no-store'}});
  }
  if(p==='/api/sellers/upload'&&method==='POST') { requireMutation(req); await rate(req,'seller-upload',20,3600); return json(await uploadFromRequest(req,'seller')); }
  if(p==='/api/sellers'&&method==='POST') {
    requireMutation(req); await rate(req,'seller-submit',5,3600); const d=await bodyJson(req); if(String(d.seller_name||'').trim().length<2||String(d.seller_name).length>100) fail(422,'Enter a valid seller name'); if(!validEmail(d.email)) fail(422,'Enter a valid seller email'); if(cleanPhone(d.whatsapp).length<10||cleanPhone(d.whatsapp).length>15) fail(422,'Enter a valid WhatsApp number with country code'); if(!(Number(d.expected_price)>0)) fail(422,'Expected price must be greater than zero');
    if(JSON.stringify(d.payload||{}).length>200000) fail(413,'Seller listing details are too large'); if((await setting('policies',{})).account_sales_enabled===false) fail(403,'Seller submissions are currently closed');
    const ref='SELL-'+crypto.randomBytes(4).toString('hex').toUpperCase(), access=token(), uid=currentCustomer(req);
    await q(`insert into public.seller_submissions(reference,access_hash,user_id,seller_name,email,whatsapp,expected_price_paise,payload_json,status)
      values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'pending')`,[ref,sha(access),uid||null,String(d.seller_name||'').slice(0,100),cleanEmail(d.email),String(d.whatsapp),moneyPaise(d.expected_price),JSON.stringify(d.payload||{})]);
    return json({reference:ref,access_token:access,status:'pending',message:'Save this access token to check your submission later.'});
  }
  if(p==='/api/sellers/lookup'&&method==='POST') {
    requireMutation(req); await rate(req,'seller-lookup',30,3600); const d=await bodyJson(req); const r=await one('select reference,seller_name,status,admin_note,created_at,updated_at,access_hash from public.seller_submissions where reference=$1',[String(d.reference||'')]);
    if(!r||!safeEq(r.access_hash,sha(d.access_token||''))) fail(404,'Submission not found'); const {access_hash,...out}=r; return json(out);
  }

  // CHECKOUT / ORDER LOOKUP
  if(p==='/api/orders'&&method==='POST') {
    requireMutation(req); await rate(req,'order-create',12,3600); const d=await bodyJson(req);
    if(String(d.customer_name||'').trim().length<2||String(d.customer_name).length>100) fail(422,'Enter a valid customer name');
    if(cleanPhone(d.whatsapp).length<10||cleanPhone(d.whatsapp).length>15) fail(422,'Enter a valid WhatsApp number with country code');
    if(d.email&&(!validEmail(d.email)||String(d.email).length>180)) fail(422,'Enter a valid email'); if(!Array.isArray(d.items)||!d.items.length) fail(422,'Your cart is empty');
    const payments=await setting('payments',{}),store=await setting('store',{}),method=d.payment_method;
    if(method==='upi'&&(!payments.upi_enabled||!payments.upi_id)) fail(400,'UPI is not configured. Choose WhatsApp or Telegram.');
    if(method==='whatsapp'&&(!payments.whatsapp_enabled||!store.whatsapp)) fail(400,'WhatsApp checkout is disabled or not configured');
    if(method==='telegram'&&(!payments.telegram_enabled||!store.telegram)) fail(400,'Telegram checkout is disabled or not configured');
    if(!['upi','whatsapp','telegram'].includes(method)) fail(422,'Invalid payment method');
    if(d.items.some(x=>x.item_type==='uc')&&!/^\d{6,20}$/.test(String(d.player_id||'').trim())) fail(422,'Enter a valid numeric BGMI Player ID for UC orders');
    const ref=`DDS-${new Date().toISOString().slice(2,10).replaceAll('-','')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`; const access=token(); const uid=currentCustomer(req);
    let created;
    try { created=await one('select public.create_store_order($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) as order_data',[ref,sha(access),uid||null,String(d.customer_name||'').slice(0,100),cleanEmail(d.email),String(d.whatsapp),String(d.player_id||''),method,JSON.stringify(d.items)]); }
    catch(e) { if(String(e.message).includes('no longer available')||String(e.message).includes('reserved by another')) fail(409,e.message); if(String(e.message).includes('UC package')) fail(404,e.message); if(String(e.message).includes('single-quantity')) fail(422,e.message); if(String(e.message).includes('quantity')||String(e.message).includes('Cart')) fail(422,e.message); throw e; }
    const order=created.order_data; const total=Number(order.total_paise)/100;
    const message=`DADDYS STORE order ${ref}. Customer: ${d.customer_name}. Amount: INR ${total.toFixed(2)}. Items: ${order.items.map(x=>x.title).join(', ')}`;
    let redirect='';
    if(method==='upi') redirect=`upi://pay?pa=${encodeURIComponent(payments.upi_id)}&pn=${encodeURIComponent(payments.payee_name||'DADDYS STORE')}&am=${total.toFixed(2)}&cu=INR&tn=${encodeURIComponent('Order '+ref)}`;
    if(method==='whatsapp') { const phone=cleanPhone(store.whatsapp); if(phone) redirect=`https://wa.me/${phone}?text=${encodeURIComponent(message)}`; }
    if(method==='telegram') { redirect=String(store.telegram||''); if(redirect&&!/^https?:\/\//i.test(redirect)) redirect=`https://t.me/${redirect.replace(/^[@/]+/,'')}`; }
    let dynamic_qr=null;
    if(method==='upi'&&redirect) { try { const QRCode=(await import('qrcode')).default; dynamic_qr=await QRCode.toDataURL(redirect,{margin:1,width:320}); } catch { dynamic_qr=null; } }
    return json({reference:ref,access_token:access,total,payment_method:method,redirect_url:redirect,upi_id:method==='upi'?payments.upi_id:null,qr_image:method==='upi'?payments.qr_image:null,dynamic_qr,instructions:payments.instructions||'',message});
  }
  if(p==='/api/orders/lookup'&&method==='POST') {
    requireMutation(req); await rate(req,'order-lookup',30,3600); const d=await bodyJson(req); const r=await one('select * from public.orders where reference=$1',[String(d.reference||'')]);
    if(!r||!safeEq(r.access_hash,sha(d.access_token||''))) fail(404,'Order not found'); return json({reference:r.reference,status:r.status,payment_status:r.payment_status,payment_method:r.payment_method,total:Number(r.total_paise)/100,items:r.items_json,created_at:r.created_at,admin_note:r.admin_note});
  }
  if(p==='/api/orders/submit-payment'&&method==='POST') {
    requireMutation(req); await rate(req,'payment-submit',8,3600); const d=await bodyJson(req); const utr=String(d.utr||'').trim();
    if(!/^[A-Za-z0-9-]{6,120}$/.test(utr)) fail(422,'Enter a valid UTR/reference'); const r=await one('select id,access_hash,payment_method from public.orders where reference=$1',[String(d.reference||'')]);
    if(!r||!safeEq(r.access_hash,sha(d.access_token||''))) fail(404,'Order not found'); if(r.payment_method!=='upi') fail(400,'UTR submission is only available for UPI orders');
    await q("update public.orders set payment_status='submitted',payment_ref=$1,updated_at=now() where id=$2",[utr,r.id]); return json({ok:true,payment_status:'submitted',message:'Payment reference submitted. Admin verification is still required.'});
  }
  if(p==='/api/customer/orders'&&method==='GET') {
    const uid=currentCustomer(req); if(!uid) fail(401,'Login required'); const rows=await q('select reference,total_paise,status,payment_status,payment_method,created_at from public.orders where user_id=$1 order by created_at desc',[uid]); return json({items:rows.map(x=>({...x,total:Number(x.total_paise)/100}))});
  }

  // WISHLIST + PRICE ALERTS
  if(p==='/api/wishlist'&&method==='GET') {
    const visitor=u.searchParams.get('visitor_id')||''; if(visitor.length<8||visitor.length>100) fail(422,'Invalid visitor ID');
    const rows=await q("select a.* from public.wishlist w join public.accounts a on a.id=w.account_id where w.visitor_id=$1 and a.status='available' order by w.created_at desc",[visitor]); return json({items:rows.map(x=>accountDict(x))});
  }
  if(p==='/api/wishlist'&&method==='POST') {
    requireMutation(req); const d=await bodyJson(req); if(String(d.visitor_id||'').length<8||String(d.account_id||'').length<10) fail(422,'Invalid wishlist details');
    const r=await one("select id from public.accounts where id=$1 and status='available'",[d.account_id]); if(!r) fail(404,'Account not available');
    await q('insert into public.wishlist(visitor_id,account_id) values($1,$2) on conflict(visitor_id,account_id) do nothing',[d.visitor_id,d.account_id]); return json({ok:true});
  }
  if(p==='/api/wishlist'&&method==='DELETE') {
    requireMutation(req); await q('delete from public.wishlist where visitor_id=$1 and account_id=$2',[u.searchParams.get('visitor_id'),u.searchParams.get('account_id')]); return json({ok:true});
  }
  if(p==='/api/price-alerts'&&method==='POST') {
    requireMutation(req); await rate(req,'price-alert',15,3600); const d=await bodyJson(req); if(String(d.visitor_id||'').length<8||String(d.visitor_id).length>100||!validEmail(d.email)) fail(422,'Enter a valid email and visitor ID');
    const r=await one("select id from public.accounts where id=$1 and status='available'",[d.account_id]); if(!r) fail(404,'Account not found');
    await q(`insert into public.price_alerts(visitor_id,account_id,email,target_price_paise) values($1,$2,$3,$4)
      on conflict(visitor_id,account_id,email) do update set target_price_paise=excluded.target_price_paise,active=true`,[d.visitor_id,d.account_id,cleanEmail(d.email),moneyPaise(d.target_price)]);
    return json({ok:true,message:'Price alert saved. Email alerts require Resend or SMTP settings in Netlify.'});
  }

  // ADMIN DATA APIS
  const adminPaths=['/api/admin/dashboard','/api/admin/accounts','/api/admin/catalog','/api/admin/uc','/api/admin/sellers','/api/admin/orders','/api/admin/settings','/api/admin/upload','/api/admin/export','/api/admin/import','/api/admin/audit'];
  if(adminPaths.some(x=>p===x)||p.startsWith('/api/admin/accounts/')||p.startsWith('/api/admin/catalog/')||p.startsWith('/api/admin/uc/')||p.startsWith('/api/admin/sellers/')||p.startsWith('/api/admin/orders/')) {
    const adminId=requireAdmin(req);
    if(p==='/api/admin/dashboard'&&method==='GET') {
      const [counts,rev,popular,recent]=await Promise.all([
        one(`select (select count(*) from public.accounts)::int accounts,(select count(*) from public.accounts where status='available')::int available_accounts,(select count(*) from public.uc_packages where active)::int uc_packages,(select count(*) from public.orders)::int orders,(select count(*) from public.orders where status='pending')::int pending_orders,(select count(*) from public.seller_submissions where status='pending')::int seller_submissions,(select count(*) from public.catalog_items)::int catalog_items,(select coalesce(sum(views),0) from public.accounts)::bigint account_views`),
        one("select coalesce(sum(total_paise),0)::bigint revenue from public.orders where payment_status='verified'"),
        q('select title,sku,views,price_paise,status from public.accounts order by views desc limit 5'),
        q('select reference,customer_name,total_paise,status,payment_status,created_at from public.orders order by created_at desc limit 8')]);
      return json({...counts,verified_revenue:Number(rev.revenue)/100,popular_accounts:popular.map(x=>({...x,price:Number(x.price_paise)/100})),recent_orders:recent.map(x=>({...x,total:Number(x.total_paise)/100}))});
    }
    if(p==='/api/admin/accounts'&&method==='GET') {
      const rows=await q('select * from public.accounts order by created_at desc'); const result=[];
      for(const r of rows) { const linked=await q('select c.id,c.name,c.category,c.rarity,ai.upgrade_level,ai.quantity from public.account_items ai join public.catalog_items c on c.id=ai.catalog_item_id where ai.account_id=$1',[r.id]); result.push({...accountDict(r,true),catalog_items:linked}); }
      return json({items:result});
    }
    if(p==='/api/admin/accounts'&&method==='POST') {
      requireMutation(req); const d=validateAccount(await bodyJson(req)); const result=await q(accountInsertSql(),[slugify(d.title),d.sku,d.title,d.description,d.price_paise,d.status,d.featured,d.verified,d.account_level,d.mythic_count,d.legendary_count,d.xsuit_count,d.gun_labs,d.glacier_level,d.rp_level,d.inventory_json,d.gallery_json,d.glacier_images_json,d.video_url]);
      await linkCatalog(result[0].id,d.catalog_item_ids); await audit(adminId,'create','account',result[0].id,d.sku); return json({ok:true,id:result[0].id,slug:result[0].slug});
    }
    if(a==='admin'&&b==='accounts'&&c&&method==='PUT'&&!parts[3]) {
      requireMutation(req); const d=validateAccount(await bodyJson(req)); const old=await one('select price_paise,title from public.accounts where id=$1',[c]); if(!old) fail(404,'Account not found');
      const conflict=await one('select id from public.accounts where sku=$1 and id<>$2',[d.sku,c]); if(conflict) fail(409,'SKU already exists');
      await q(`update public.accounts set sku=$1,title=$2,description=$3,price_paise=$4,status=$5,featured=$6,verified=$7,account_level=$8,mythic_count=$9,legendary_count=$10,xsuit_count=$11,gun_labs=$12,glacier_level=$13,rp_level=$14,inventory_json=$15::jsonb,gallery_json=$16::jsonb,glacier_images_json=$17::jsonb,video_url=$18,updated_at=now() where id=$19`,[d.sku,d.title,d.description,d.price_paise,d.status,d.featured,d.verified,d.account_level,d.mythic_count,d.legendary_count,d.xsuit_count,d.gun_labs,d.glacier_level,d.rp_level,d.inventory_json,d.gallery_json,d.glacier_images_json,d.video_url,c]);
      await linkCatalog(c,d.catalog_item_ids); await handlePriceDrop(c,old.price_paise,d.price_paise,d.title); await audit(adminId,'update','account',c,d.sku); return json({ok:true});
    }
    if(a==='admin'&&b==='accounts'&&c&&parts[3]==='duplicate'&&method==='POST') {
      requireMutation(req); const r=await one('select * from public.accounts where id=$1',[c]); if(!r) fail(404,'Account not found');
      const sku=`${r.sku}-COPY-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
      const result=await q(accountInsertSql(),[slugify(r.title),sku,`${r.title} (Copy)`,r.description,r.price_paise,'draft',false,false,r.account_level,r.mythic_count,r.legendary_count,r.xsuit_count,r.gun_labs,r.glacier_level,r.rp_level,JSON.stringify(r.inventory_json),JSON.stringify(r.gallery_json),JSON.stringify(r.glacier_images_json),r.video_url]);
      const linked=await q('select catalog_item_id,upgrade_level,quantity from public.account_items where account_id=$1',[c]); for(const x of linked) await q('insert into public.account_items(account_id,catalog_item_id,upgrade_level,quantity) values($1,$2,$3,$4)',[result[0].id,x.catalog_item_id,x.upgrade_level,x.quantity]);
      await audit(adminId,'duplicate','account',result[0].id,sku); return json({ok:true,id:result[0].id,slug:result[0].slug});
    }
    if(a==='admin'&&b==='accounts'&&c&&method==='DELETE'&&!parts[3]) { requireMutation(req); await q('delete from public.accounts where id=$1',[c]); await audit(adminId,'delete','account',c); return json({ok:true}); }

    if(p==='/api/admin/catalog'&&method==='GET') { const rows=await q('select * from public.catalog_items order by category,name'); return json({items:rows.map(catalogDict)}); }
    if(p==='/api/admin/catalog'&&method==='POST') {
      requireMutation(req); const d=validateCatalog(await bodyJson(req)); const r=await one(`insert into public.catalog_items(name,category,rarity,image_url,description,metadata_json,active) values($1,$2,$3,$4,$5,$6::jsonb,$7) returning id`,[d.name,d.category,d.rarity,d.image_url,d.description,d.metadata_json,d.active]); await audit(adminId,'create','catalog_item',r.id,d.name); return json({ok:true,id:r.id});
    }
    if(a==='admin'&&b==='catalog'&&c&&method==='PUT') { requireMutation(req); const d=validateCatalog(await bodyJson(req)); const r=await q('update public.catalog_items set name=$1,category=$2,rarity=$3,image_url=$4,description=$5,metadata_json=$6::jsonb,active=$7,updated_at=now() where id=$8 returning id',[d.name,d.category,d.rarity,d.image_url,d.description,d.metadata_json,d.active,c]); if(!r.length) fail(404,'Catalog item not found'); await audit(adminId,'update','catalog_item',c,d.name); return json({ok:true}); }
    if(a==='admin'&&b==='catalog'&&c&&method==='DELETE') { requireMutation(req); await q('delete from public.catalog_items where id=$1',[c]); await audit(adminId,'delete','catalog_item',c); return json({ok:true}); }

    if(p==='/api/admin/uc'&&method==='GET') { const rows=await q('select * from public.uc_packages order by sort_order,uc_amount'); return json({items:rows.map(x=>({...x,price:Number(x.price_paise)/100}))}); }
    if(p==='/api/admin/uc'&&method==='POST') { requireMutation(req); const d=validateUc(await bodyJson(req)); const r=await one('insert into public.uc_packages(sku,name,uc_amount,price_paise,description,active,sort_order) values($1,$2,$3,$4,$5,$6,$7) returning id',[d.sku,d.name,d.uc_amount,d.price_paise,d.description,d.active,d.sort_order]); await audit(adminId,'create','uc_package',r.id,d.sku); return json({ok:true,id:r.id}); }
    if(a==='admin'&&b==='uc'&&c&&method==='PUT') { requireMutation(req); const d=validateUc(await bodyJson(req)); const r=await q('update public.uc_packages set sku=$1,name=$2,uc_amount=$3,price_paise=$4,description=$5,active=$6,sort_order=$7,updated_at=now() where id=$8 returning id',[d.sku,d.name,d.uc_amount,d.price_paise,d.description,d.active,d.sort_order,c]); if(!r.length) fail(404,'Package not found'); await audit(adminId,'update','uc_package',c,d.sku); return json({ok:true}); }
    if(a==='admin'&&b==='uc'&&c&&method==='DELETE') { requireMutation(req); await q("update public.uc_packages set active=false,updated_at=now() where id=$1",[c]); await audit(adminId,'disable','uc_package',c); return json({ok:true}); }

    if(p==='/api/admin/sellers'&&method==='GET') {
      const rows=await q('select * from public.seller_submissions order by created_at desc'); const items=[];
      for(const x of rows) { const item={...x,expected_price:Number(x.expected_price_paise)/100,payload:x.payload_json,access_hash:'[hidden]'}; delete item.payload_json; delete item.expected_price_paise; items.push(item); }
      return json({items});
    }
    if(a==='admin'&&b==='sellers'&&c&&method==='PUT') {
      requireMutation(req); const d=await bodyJson(req); const allowed=['pending','reviewing','approved','rejected','published','withdrawn']; if(!allowed.includes(d.status)) fail(422,'Invalid seller status');
      const r=await one('select * from public.seller_submissions where id=$1',[c]); if(!r) fail(404,'Submission not found'); let payload=r.payload_json||{}; let listingId=null;
      await q('update public.seller_submissions set status=$1,admin_note=$2,updated_at=now() where id=$3',[d.status,String(d.admin_note||'').slice(0,2000),c]);
      if(d.status==='approved'&&!payload.published_account_id) {
        const title=String(payload.title||`${r.seller_name}'s BGMI account`).slice(0,150), sku=`SELL-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
        const promoted=[]; for(const img of (Array.isArray(payload.gallery)?payload.gallery:[])) promoted.push(await promoteSellerProof(img)); payload.gallery=promoted;
        const result=await q(accountInsertSql(),[slugify(title),sku,title,String(payload.description||''),r.expected_price_paise,'draft',false,false,safeInt(payload.account_level,1,1,100),safeInt(payload.mythic_count),safeInt(payload.legendary_count),safeInt(payload.xsuit_count),safeInt(payload.gun_labs),safeInt(payload.glacier_level,0,0,7),safeInt(payload.rp_level,0,0,100),JSON.stringify(payload.inventory||{}),JSON.stringify(payload.gallery||[]),JSON.stringify(payload.glacier_images||{}),String(payload.video_url||'')]);
        listingId=result[0].id; await q('update public.accounts set seller_name=$1,seller_submission_id=$2 where id=$3',[r.seller_name,c,listingId]); payload.published_account_id=listingId; await q('update public.seller_submissions set payload_json=$1::jsonb where id=$2',[JSON.stringify(payload),c]);
      }
      await audit(adminId,'seller_status','seller_submission',c,d.status); return json({ok:true,created_draft_account_id:listingId});
    }
    if(p==='/api/admin/orders'&&method==='GET') { const rows=await q('select * from public.orders order by created_at desc'); return json({items:rows.map(x=>({...x,total:Number(x.total_paise)/100,items:x.items_json,access_hash:'[hidden]'}))}); }
    if(a==='admin'&&b==='orders'&&c&&method==='PUT') {
      requireMutation(req); const d=await bodyJson(req); const r=await one('select items_json,payment_method from public.orders where id=$1',[c]); if(!r) fail(404,'Order not found');
      const allowedStatus=['pending','processing','completed','cancelled','refunded'], allowedPay=['pending','submitted','verified','failed','refunded'];
      if(!allowedStatus.includes(d.status)||!allowedPay.includes(d.payment_status)) fail(422,'Invalid order or payment status');
      if(d.status==='completed'&&d.payment_status!=='verified') fail(409,'An order cannot be completed until payment is verified');
      if(r.payment_method==='upi'&&d.payment_status==='verified'&&!String(d.payment_ref||'').trim()) fail(422,'Enter the UTR/payment reference before verifying a UPI order');
      if(d.status==='refunded'&&d.payment_status!=='refunded') fail(409,'A refunded order must also have refunded payment status');
      const client=await db().connect();
      try {
        await client.query('begin');
        await client.query('update public.orders set status=$1,payment_status=$2,payment_ref=$3,admin_note=$4,updated_at=now() where id=$5',[d.status,d.payment_status,String(d.payment_ref||''),String(d.admin_note||'').slice(0,2000),c]);
        for(const line of (r.items_json||[])) if(line.type==='account') {
          if(d.status==='completed'&&d.payment_status==='verified') await client.query("update public.accounts set status='sold',updated_at=now() where id=$1",[line.id]);
          else if(['cancelled','refunded'].includes(d.status)||['failed','refunded'].includes(d.payment_status)) await client.query("update public.accounts set status='available',updated_at=now() where id=$1 and status='reserved'",[line.id]);
        }
        await client.query('commit');
      } catch(error) { await client.query('rollback'); throw error; } finally { client.release(); }
      await audit(adminId,'order_update','order',c,`${d.status}/${d.payment_status}`); return json({ok:true});
    }
    if(p==='/api/admin/settings'&&method==='GET') { const [store,payments,policies]=await Promise.all([setting('store',{}),setting('payments',{}),setting('policies',{})]); return json({store,payments,policies}); }
    if(p==='/api/admin/settings'&&method==='PUT') {
      requireMutation(req); const d=await bodyJson(req); const storeAllow=['name','tagline','whatsapp','telegram','support_email','hero_title','hero_subtitle','hero_image'], payAllow=['upi_enabled','upi_id','payee_name','qr_image','whatsapp_enabled','telegram_enabled','default_method','instructions'], policyAllow=['account_sales_enabled','terms_url','privacy_url','authorization_note'];
      const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>Object.hasOwn(o||{},k)).map(k=>[k,o[k]])); const store=pick(d.store,storeAllow), payments=pick(d.payments,payAllow), policies=pick(d.policies,policyAllow);
      if(payments.upi_id&&!/^[A-Za-z0-9._-]{2,100}@[A-Za-z0-9.-]{2,80}$/.test(payments.upi_id)) fail(422,'Enter a valid UPI ID'); if(payments.default_method&&!['upi','whatsapp','telegram'].includes(payments.default_method)) fail(422,'Invalid default payment method');
      await Promise.all([writeSetting('store',store),writeSetting('payments',payments),writeSetting('policies',policies)]); await audit(adminId,'settings_update','settings','global'); return json({ok:true});
    }
    if(p==='/api/admin/upload'&&method==='POST') { requireMutation(req); return json(await uploadFromRequest(req,'admin',adminId)); }
    if(p==='/api/admin/export'&&method==='GET') {
      const catalog=await q('select name,category,rarity,image_url,description,metadata_json as metadata,active from public.catalog_items order by category,name');
      const uc=await q('select sku,name,uc_amount,price_paise,description,active,sort_order from public.uc_packages order by sort_order,uc_amount');
      const rows=await q('select * from public.accounts order by created_at'); const accounts=[];
      for(const r of rows) { const item=accountDict(r,true); const linked=await q('select c.name,c.category,ai.upgrade_level,ai.quantity from public.account_items ai join public.catalog_items c on c.id=ai.catalog_item_id where ai.account_id=$1',[r.id]); item.catalog_item_refs=linked; accounts.push(item); }
      return json({format:'daddys-store-inventory',version:1,exported_at:now(),accounts,catalog,uc_packages:uc.map(x=>({...x,price:Number(x.price_paise)/100}))});
    }
    if(p==='/api/admin/import'&&method==='POST') {
      requireMutation(req); const d=await bodyJson(req); if(d.format!=='daddys-store-inventory'||d.version!==1) fail(422,'Unsupported inventory backup format');
      const cats=d.catalog||[],packages=d.uc_packages||[],accounts=d.accounts||[]; if(![cats,packages,accounts].every(Array.isArray)||cats.length+packages.length+accounts.length>5000) fail(422,'Backup data is invalid or exceeds the import limit');
      const merged={catalog:0,uc_packages:0,accounts:0}; const lookup=new Map();
      for(const x of cats) { const old=await one('select id from public.catalog_items where lower(name)=lower($1) and lower(category)=lower($2)',[x.name,x.category]); const meta=JSON.stringify(x.metadata||{}); let r;
        if(old) { r=old; await q('update public.catalog_items set rarity=$1,image_url=$2,description=$3,metadata_json=$4::jsonb,active=$5,updated_at=now() where id=$6',[x.rarity||'',x.image_url||'',x.description||'',meta,x.active!==false,old.id]); }
        else { r=await one('insert into public.catalog_items(name,category,rarity,image_url,description,metadata_json,active) values($1,$2,$3,$4,$5,$6::jsonb,$7) returning id',[x.name,x.category,x.rarity||'',x.image_url||'',x.description||'',meta,x.active!==false]); merged.catalog++; }
        lookup.set(`${String(x.name).toLowerCase()}|${String(x.category).toLowerCase()}`,r.id);
      }
      for(const x of packages) { const price=moneyPaise(x.price); const old=await one('select id from public.uc_packages where sku=$1',[String(x.sku).toUpperCase()]);
        if(old) await q('update public.uc_packages set name=$1,uc_amount=$2,price_paise=$3,description=$4,active=$5,sort_order=$6,updated_at=now() where id=$7',[x.name,x.uc_amount,price,x.description||'',x.active!==false,safeInt(x.sort_order),old.id]);
        else { await q('insert into public.uc_packages(sku,name,uc_amount,price_paise,description,active,sort_order) values($1,$2,$3,$4,$5,$6,$7)',[String(x.sku).toUpperCase(),x.name,x.uc_amount,price,x.description||'',x.active!==false,safeInt(x.sort_order)]); merged.uc_packages++; }
      }
      for(const x of accounts) { const pld=validateAccount({title:x.title,sku:x.sku,description:x.description,price:x.price,status:x.status,featured:x.featured,verified:x.verified,account_level:x.account_level,mythic_count:x.mythic_count,legendary_count:x.legendary_count,xsuit_count:x.xsuit_count,gun_labs:x.gun_labs,glacier_level:x.glacier_level,rp_level:x.rp_level,inventory:x.inventory||{},gallery:x.gallery||[],glacier_images:x.glacier_images||{},video_url:x.video_url||[]});
        const old=await one('select id from public.accounts where sku=$1',[pld.sku]); let aid;
        if(old) { aid=old.id; await q('update public.accounts set title=$1,description=$2,price_paise=$3,status=$4,featured=$5,verified=$6,account_level=$7,mythic_count=$8,legendary_count=$9,xsuit_count=$10,gun_labs=$11,glacier_level=$12,rp_level=$13,inventory_json=$14::jsonb,gallery_json=$15::jsonb,glacier_images_json=$16::jsonb,video_url=$17,updated_at=now() where id=$18',[pld.title,pld.description,pld.price_paise,pld.status,pld.featured,pld.verified,pld.account_level,pld.mythic_count,pld.legendary_count,pld.xsuit_count,pld.gun_labs,pld.glacier_level,pld.rp_level,pld.inventory_json,pld.gallery_json,pld.glacier_images_json,pld.video_url,aid]); }
        else { const res=await q(accountInsertSql(),[slugify(pld.title),pld.sku,pld.title,pld.description,pld.price_paise,pld.status,pld.featured,pld.verified,pld.account_level,pld.mythic_count,pld.legendary_count,pld.xsuit_count,pld.gun_labs,pld.glacier_level,pld.rp_level,pld.inventory_json,pld.gallery_json,pld.glacier_images_json,pld.video_url]); aid=res[0].id; merged.accounts++; }
        await q('delete from public.account_items where account_id=$1',[aid]); for(const ref of (x.catalog_item_refs||[])) { const cid=lookup.get(`${String(ref.name||'').toLowerCase()}|${String(ref.category||'').toLowerCase()}`); if(cid) await q('insert into public.account_items(account_id,catalog_item_id,upgrade_level,quantity) values($1,$2,$3,$4) on conflict(account_id,catalog_item_id) do nothing',[aid,cid,safeInt(ref.upgrade_level),safeInt(ref.quantity,1,1,100)]); }
      }
      await audit(adminId,'inventory_import','backup','',JSON.stringify(merged)); return json({ok:true,merged,note:'Existing records matched by SKU or catalog name/category. Unlisted records were not deleted.'});
    }
    if(p==='/api/admin/audit'&&method==='GET') { const rows=await q('select action,entity,entity_id,detail,created_at from public.audit_logs order by created_at desc limit 150'); return json({items:rows}); }
  }

  fail(404,'API route not found');
}

export default async (request, context) => {
  try { return await handle(request); }
  catch (e) {
    if(e instanceof HttpError) return json({detail:e.message},e.status);
    if(e?.code==='23505') return json({detail:'This record conflicts with existing data.'},409);
    if(e?.code==='23503') return json({detail:'This record is referenced by another record and cannot be deleted.'},409);
    console.error('DADDYS STORE API error:',e?.stack||e);
    return json({detail:process.env.NODE_ENV==='development'?e.message:'The server could not complete this request. Check deployment configuration and logs.'},500);
  }
};