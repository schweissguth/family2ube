import { Container, getContainer } from "@cloudflare/containers";

const CHUNK_SIZE = 8 * 1024 * 1024;
const json = (x, status=200) => new Response(JSON.stringify(x), {status, headers:{"content-type":"application/json","cache-control":"no-store"}});
const safe = (s) => String(s || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0,80);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

export class HlsContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = false;
}

HlsContainer.outboundByHost = {
  "r2.internal": async (request, env) => {
    const u = new URL(request.url);
    const key = decodeURIComponent(u.pathname.slice(1));
    if (!key || key.includes("..")) return new Response("bad key", {status:400});
    if (request.method === "HEAD") {
      const h = await env.MEDIA.head(key);
      return h ? new Response(null, {headers:{"content-length":String(h.size)}}) : new Response(null,{status:404});
    }
    if (request.method === "GET") {
      let range;
      const m = request.headers.get("range")?.match(/^bytes=(\d+)-(\d+)$/);
      if (m) range = {offset:Number(m[1]), length:Number(m[2])-Number(m[1])+1};
      const o = await env.MEDIA.get(key, range ? {range} : undefined);
      if (!o) return new Response("not found", {status:404});
      const headers = new Headers({"content-type":o.httpMetadata?.contentType || "application/octet-stream"});
      if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset+range.length-1}/${o.size}`);
      return new Response(o.body, {status: range ? 206 : 200, headers});
    }
    if (request.method === "PUT") {
      await env.MEDIA.put(key, request.body, {httpMetadata:{contentType:request.headers.get("content-type") || "application/octet-stream"}});
      return new Response("ok");
    }
    if (request.method === "DELETE") { await env.MEDIA.delete(key); return new Response("ok"); }
    return new Response("method", {status:405});
  }
};

function page() { return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MP4 to HLS</title><style>
body{font:16px system-ui;max-width:720px;margin:40px auto;padding:0 18px;background:#0b1220;color:#e8eefc}main{background:#151f33;padding:24px;border-radius:16px}label{display:block;margin:14px 0 6px}input,button{box-sizing:border-box;width:100%;padding:12px;border-radius:8px;border:1px solid #52617a;background:#0d1728;color:#fff}button{margin-top:18px;background:#f48120;border:0;font-weight:700;cursor:pointer}button:disabled{opacity:.55}.bar{height:18px;background:#2a3549;border-radius:9px;overflow:hidden;margin-top:16px}.bar i{display:block;height:100%;width:0;background:#36c98f;transition:width .2s}.small{color:#aebbd0}.error{color:#ff8d8d;white-space:pre-wrap}</style></head><body><main><h1>MP4 to 480p HLS</h1><form id="f"><label>Username</label><input id="user" required pattern="[A-Za-z0-9_-]+"><label>Folder name</label><input id="folder" required pattern="[A-Za-z0-9_-]+"><label>MP4 file</label><input id="file" type="file" accept="video/mp4,.mp4" required><button id="go">Upload and convert</button></form><div class="bar"><i id="bar"></i></div><p id="msg" class="small">Ready</p><p id="err" class="error"></p></main><script>
const $=id=>document.getElementById(id), sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function req(url,opt={}){const r=await fetch(url,opt);if(!r.ok)throw Error(await r.text());return r.json()}
$('f').addEventListener('submit',async e=>{e.preventDefault();$('go').disabled=true;$('err').textContent='';try{
 const file=$('file').files[0], username=$('user').value, folder=$('folder').value;
 if(!file || !file.name.toLowerCase().endsWith('.mp4')) throw Error('Choose an .mp4 file.');
 const init=await req('/api/init',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,folder,filename:file.name,size:file.size,type:file.type})});
 for(let i=0;i<init.parts;i++){const start=i*init.chunkSize,end=Math.min(file.size,start+init.chunkSize);await req(`/api/upload/${init.job}/${i+1}`,{method:'PUT',body:file.slice(start,end)});const p=Math.round(end/file.size*45);$('bar').style.width=p+'%';$('msg').textContent=`Uploading: ${Math.round(end/file.size*100)}%`;}
 await req(`/api/complete/${init.job}`,{method:'POST'});$('msg').textContent='Starting FFmpeg…';
 while(true){const s=await req(`/api/status/${init.job}?t=${Date.now()}`);const p=45+Math.round((s.percent||0)*.55);$('bar').style.width=Math.min(p,100)+'%';$('msg').textContent=`${s.stage||'working'}: ${s.percent||0}% (${s.segments||0} segments uploaded)`;if(s.error)throw Error(s.error);if(s.done){$('bar').style.width='100%';$('msg').innerHTML=`Complete: <a style="color:#70d6ff" href="/media/${encodeURIComponent(init.username)}/${encodeURIComponent(init.folder)}/playlist.m3u8">playlist.m3u8</a>`;break}await sleep(1500)}
 }catch(x){$('err').textContent=x.message;$('msg').textContent='Stopped'}finally{$('go').disabled=false}});
</script></body></html>`; }

export default { async fetch(request, env) {
  const u = new URL(request.url), p=u.pathname.split('/').filter(Boolean);
  try {
    if (request.method==='GET' && u.pathname==='/') return new Response(page(),{headers:{'content-type':'text/html;charset=utf-8'}});
    if (request.method==='POST' && u.pathname==='/api/init') {
      const b=await request.json(), username=safe(b.username), folder=safe(b.folder), filename=safe(String(b.filename).replace(/\.mp4$/i,''))+'.mp4';
      if(!username||!folder||!Number.isFinite(b.size)||b.size<1) return json({error:'Invalid username, folder, or file'},400);
      const job=crypto.randomUUID(), key=`_jobs/${job}/source.mp4`, mp=await env.MEDIA.createMultipartUpload(key);
      const parts=Math.ceil(b.size/CHUNK_SIZE);
      await env.MEDIA.put(`_jobs/${job}/meta.json`,JSON.stringify({job,username,folder,filename,key,uploadId:mp.uploadId,parts,size:b.size,received:[],created:Date.now()}),{httpMetadata:{contentType:'application/json'}});
      return json({job,username,folder,chunkSize:CHUNK_SIZE,parts});
    }
    if (request.method==='PUT' && p[0]==='api' && p[1]==='upload') {
      const job=p[2], n=Number(p[3]), mo=await env.MEDIA.get(`_jobs/${job}/meta.json`); if(!mo)return json({error:'job not found'},404); const m=await mo.json();
      if(!Number.isInteger(n)||n<1||n>m.parts) return json({error:'bad part'},400);
      const upload=env.MEDIA.resumeMultipartUpload(m.key,m.uploadId), part=await upload.uploadPart(n,request.body);
      m.received=m.received.filter(x=>x.partNumber!==n);m.received.push({partNumber:n,etag:part.etag});
      await env.MEDIA.put(`_jobs/${job}/meta.json`,JSON.stringify(m),{httpMetadata:{contentType:'application/json'}}); return json({ok:true,part:n});
    }
    if (request.method==='POST' && p[0]==='api' && p[1]==='complete') {
      const job=p[2], mo=await env.MEDIA.get(`_jobs/${job}/meta.json`);if(!mo)return json({error:'job not found'},404);const m=await mo.json();
      if(m.received.length!==m.parts)return json({error:`Only ${m.received.length}/${m.parts} chunks received`},409);
      await env.MEDIA.resumeMultipartUpload(m.key,m.uploadId).complete(m.received.sort((a,b)=>a.partNumber-b.partNumber));
      await env.MEDIA.put(`_jobs/${job}/status.json`,JSON.stringify({stage:'queued',percent:0,segments:0,done:false}),{httpMetadata:{contentType:'application/json'}});
      const c=getContainer(env.HLS_CONTAINER,job); const r=await c.fetch(new Request('http://container/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(m)}));
      if(!r.ok)return json({error:await r.text()},500); return json({ok:true});
    }
    if (request.method==='GET' && p[0]==='api' && p[1]==='status') { const o=await env.MEDIA.get(`_jobs/${p[2]}/status.json`);return o?new Response(o.body,{headers:{'content-type':'application/json','cache-control':'no-store'}}):json({stage:'waiting',percent:0}); }
    if (request.method==='GET' && p[0]==='media' && p.length>=4) { const key=p.slice(1).map(decodeURIComponent).join('/');const o=await env.MEDIA.get(key);if(!o)return new Response('Not found',{status:404});return new Response(o.body,{headers:{'content-type':o.httpMetadata?.contentType||'application/octet-stream','accept-ranges':'bytes','access-control-allow-origin':'*'}}); }
    return new Response('Not found',{status:404});
  } catch(e) { return json({error:e?.message||String(e)},500); }
}};
