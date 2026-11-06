import crypto from 'node:crypto';
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { Pool } from 'pg';

function loadDotEnv() {
  try {
    for (const line of fs.readFileSync('.env','utf8').split(/\r?\n/)) {
      const m=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if(m&&!process.env[m[1]]) process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');
    }
  } catch {}
}
async function hidden(prompt) {
  if(!input.isTTY || typeof input.setRawMode!=='function') throw new Error('Run this script in an interactive terminal so the password can be hidden.');
  output.write(prompt); input.setRawMode(true); input.resume();
  return await new Promise((resolve,reject)=>{
    let value='';
    const finish=(err)=>{ input.setRawMode(false); input.pause(); input.removeListener('data',onData); output.write('\n'); err?reject(err):resolve(value); };
    const onData=(chunk)=>{ for(const c of chunk.toString('utf8')) {
      if(c==='\u0003') return finish(new Error('Cancelled.'));
      if(c==='\r'||c==='\n') return finish();
      if(c==='\u007f'||c==='\b') value=value.slice(0,-1); else if(c>=' ') value+=c;
    }};
    input.on('data',onData);
  });
}
loadDotEnv();
const rl=readline.createInterface({input,output});
let pool;
try {
  if(!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL in your local .env before running this script.');
  const username=(process.env.ADMIN_USERNAME||await rl.question('Admin username [owner]: ')).trim()||'owner';
  rl.close();
  const password=await hidden('Choose a unique admin password (14+ characters; input hidden): ');
  if(password.length<14) throw new Error('Password must be at least 14 characters.');
  const confirm=await hidden('Confirm password: ');
  if(password!==confirm) throw new Error('Passwords do not match.');
  const salt=crypto.randomBytes(16); const digest=crypto.pbkdf2Sync(password,salt,310000,32,'sha256');
  const encoded=`pbkdf2_sha256$${salt.toString('hex')}$${digest.toString('hex')}`;
  pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,ssl:{rejectUnauthorized:false}});
  await pool.query(`insert into public.admins(username,password_hash) values($1,$2)
    on conflict(username) do update set password_hash=excluded.password_hash`,[username,encoded]);
  console.log(`Admin '${username}' is ready. Password stored as a PBKDF2 hash.`);
} catch(e) { console.error(e.message); process.exitCode=1; }
finally { rl.close(); if(pool) await pool.end(); }