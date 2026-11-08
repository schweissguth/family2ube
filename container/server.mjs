import http from 'node:http';
import fs from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
const R2='http://r2.internal/';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function r2key(key,opt={}){const r=await fetch(R2+key.split('/').map(encodeURIComponent).join('/'),opt);if(!r.ok)throw Error(`R2 ${opt.method||'GET'} ${key}: ${r.status} ${await r.text()}`);return r}
async function status(job,x){await r2key(`_jobs/${job}/status.json`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(x)})}
async function download(key,file){const h=await r2key(key,{method:'HEAD'}), size=Number(h.headers.get('content-length')), step=64*1024*1024;const out=createWriteStream(file);for(let s=0;s<size;s+=step){const e=Math.min(size-1,s+step-1),r=await r2key(key,{headers:{range:`bytes=${s}-${e}`}});for await(const chunk of r.body)if(!out.write(chunk))await new Promise(x=>out.once('drain',x));}out.end();await new Promise((ok,no)=>out.on('finish',ok).on('error',no));}
async function uploadFile(key,file,type){const st=await fs.stat(file);const stream=createReadStream(file);await r2key(key,{method:'PUT',headers:{'content-type':type,'content-length':String(st.size)},body:stream,duplex:'half'});}
function run(cmd,args){return new Promise((ok,no)=>{const p=spawn(cmd,args);let out='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>out+=d);p.on('close',c=>c===0?ok(out):no(Error(out.slice(-4000))));});}
let busy=false;
async function convert(m){if(busy)throw Error('container is busy');busy=true;const dir=`/tmp/${m.job}`,input=`${dir}/input.mp4`,base=path.basename(m.filename,'.mp4').replace(/[^a-z0-9_-]/g,'-')||'video',prefix=`${m.username}/${m.folder}`;await fs.mkdir(dir,{recursive:true});try{
 await status(m.job,{stage:'downloading source',percent:0,segments:0,done:false});await download(m.key,input);
 const probe=await run('ffprobe',['-v','error','-show_entries','format=duration','-of','default=nw=1:nk=1',input]);const duration=Math.max(1,Number(probe.trim())||1);
 const playlist=`${dir}/playlist.m3u8`, pattern=`${dir}/${base}%03d.ts`;let uploaded=new Set(),finished=false,fferr='';
 const args=['-hide_banner','-y','-i',input,'-vf','scale=-2:480','-c:v','libx264','-preset','medium','-crf','23','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-force_key_frames','expr:gte(t,n_forced*60)','-f','hls','-hls_time','60','-hls_playlist_type','vod','-hls_flags','temp_file','-hls_segment_filename',pattern,'-progress','pipe:1','-nostats',playlist];
 const ff=spawn('ffmpeg',args);let buf='',lastPct=0;ff.stdout.on('data',d=>{buf+=d;const lines=buf.split('\n');buf=lines.pop();for(const line of lines){const [k,v]=line.trim().split('=');if(k==='out_time_ms')lastPct=Math.min(99,Math.max(0,Math.round((Number(v)/1000000)/duration*100)));}});ff.stderr.on('data',d=>fferr+=(d.toString()).slice(-4000));
 const uploader=(async()=>{while(!finished){const names=await fs.readdir(dir);for(const n of names.filter(n=>n.endsWith('.ts')).sort()){if(!uploaded.has(n)){await uploadFile(`${prefix}/${n}`,`${dir}/${n}`,'video/mp2t');uploaded.add(n);}}await status(m.job,{stage:'converting and uploading',percent:lastPct,segments:uploaded.size,done:false});await sleep(1000)}})();
 const code=await new Promise(r=>ff.on('close',r));finished=true;await uploader;if(code!==0)throw Error(`ffmpeg exited ${code}: ${fferr.slice(-2000)}`);
 for(const n of (await fs.readdir(dir)).filter(n=>n.endsWith('.ts')).sort())if(!uploaded.has(n)){await uploadFile(`${prefix}/${n}`,`${dir}/${n}`,'video/mp2t');uploaded.add(n)}
 await uploadFile(`${prefix}/playlist.m3u8`,playlist,'application/vnd.apple.mpegurl');await status(m.job,{stage:'complete',percent:100,segments:uploaded.size,done:true,playlist:`${prefix}/playlist.m3u8`});await r2key(m.key,{method:'DELETE'});
 }catch(e){await status(m.job,{stage:'failed',percent:0,segments:0,done:false,error:e.message});throw e}finally{busy=false;await fs.rm(dir,{recursive:true,force:true})}}
const server=http.createServer(async(req,res)=>{if(req.url==='/health'){res.end('ok');return}if(req.url==='/start'&&req.method==='POST'){let s='';for await(const c of req)s+=c;try{const m=JSON.parse(s);convert(m).catch(console.error);res.writeHead(202,{'content-type':'application/json'});res.end('{"started":true}')}catch(e){res.writeHead(400);res.end(e.message)}return}res.writeHead(404);res.end('not found')});server.listen(8080,'0.0.0.0');
