import { Container, getContainer } from "@cloudflare/containers";

const CHUNK_SIZE = 8 * 1024 * 1024;

const json = (x, status = 200) =>
  new Response(JSON.stringify(x), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });

const safe = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

export class HlsContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "30m";
  enableInternet = false;
}

HlsContainer.outboundByHost = {
  "r2.internal": async (request, env) => {
    const u = new URL(request.url);
    const key = decodeURIComponent(u.pathname.slice(1));

    if (!key || key.includes("..")) {
      return new Response("bad key", { status: 400 });
    }

    if (request.method === "HEAD") {
      const h = await env.MEDIA.head(key);

      return h
        ? new Response(null, {
            headers: {
              "content-length": String(h.size),
            },
          })
        : new Response(null, { status: 404 });
    }

    if (request.method === "GET") {
      let range;

      const m = request.headers
        .get("range")
        ?.match(/^bytes=(\d+)-(\d+)$/);

      if (m) {
        range = {
          offset: Number(m[1]),
          length: Number(m[2]) - Number(m[1]) + 1,
        };
      }

      const o = await env.MEDIA.get(
        key,
        range ? { range } : undefined
      );

      if (!o) {
        return new Response("not found", { status: 404 });
      }

      const headers = new Headers({
        "content-type":
          o.httpMetadata?.contentType ||
          "application/octet-stream",
      });

      if (range) {
        headers.set(
          "content-range",
          `bytes ${range.offset}-${range.offset + range.length - 1}/${o.size}`
        );
      }

      return new Response(o.body, {
        status: range ? 206 : 200,
        headers,
      });
    }

    if (request.method === "PUT") {
      await env.MEDIA.put(key, request.body, {
        httpMetadata: {
          contentType:
            request.headers.get("content-type") ||
            "application/octet-stream",
        },
      });

      return new Response("ok");
    }

    if (request.method === "DELETE") {
      await env.MEDIA.delete(key);
      return new Response("ok");
    }

    return new Response("method", { status: 405 });
  },
};

function page() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>MP4 to HLS</title>

<style>
body {
  font: 16px system-ui;
  max-width: 720px;
  margin: 40px auto;
  padding: 0 18px;
  background: #0b1220;
  color: #e8eefc;
}

main {
  background: #151f33;
  padding: 24px;
  border-radius: 16px;
}

label {
  display: block;
  margin: 14px 0 6px;
}

input,
button {
  box-sizing: border-box;
  width: 100%;
  padding: 12px;
  border-radius: 8px;
  border: 1px solid #52617a;
  background: #0d1728;
  color: #fff;
}

button {
  margin-top: 18px;
  background: #f48120;
  border: 0;
  font-weight: 700;
  cursor: pointer;
}

button:disabled {
  opacity: 0.55;
}

.bar {
  height: 18px;
  background: #2a3549;
  border-radius: 9px;
  overflow: hidden;
  margin-top: 16px;
}

.bar i {
  display: block;
  height: 100%;
  width: 0;
  background: #36c98f;
  transition: width 0.2s;
}

.small {
  color: #aebbd0;
}

.error {
  color: #ff8d8d;
  white-space: pre-wrap;
}

a {
  color: #70d6ff;
}
</style>
</head>

<body>

<main>

<h1>MP4 to 480p HLS</h1>

<form id="f">

<label>Username</label>
<input
  id="user"
  required
  pattern="[A-Za-z0-9_-]+"
>

<label>Folder name</label>
<input
  id="folder"
  required
  pattern="[A-Za-z0-9_-]+"
>

<label>MP4 file</label>
<input
  id="file"
  type="file"
  accept="video/mp4,.mp4"
  required
>

<button id="go">
Upload and convert
</button>

</form>

<div class="bar">
<i id="bar"></i>
</div>

<p id="msg" class="small">Ready</p>
<p id="err" class="error"></p>

</main>

<script>

const $ = function(id) {
  return document.getElementById(id);
};

const sleep = function(ms) {
  return new Promise(function(resolve) {
    setTimeout(resolve, ms);
  });
};

async function req(url, opt) {

  if (!opt) {
    opt = {};
  }

  const r = await fetch(url, opt);

  if (!r.ok) {
    throw new Error(await r.text());
  }

  return r.json();
}


$('f').addEventListener('submit', async function(e) {

  e.preventDefault();

  $('go').disabled = true;
  $('err').textContent = '';

  try {

    const file = $('file').files[0];
    const username = $('user').value;
    const folder = $('folder').value;

    if (!file || !file.name.toLowerCase().endsWith('.mp4')) {
      throw new Error('Choose an .mp4 file.');
    }


    //
    // INITIALIZE UPLOAD
    //

    const init = await req('/api/init', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        username: username,
        folder: folder,
        filename: file.name,
        size: file.size,
        type: file.type
      })
    });


    //
    // UPLOAD MP4 IN CHUNKS
    //

    for (let i = 0; i < init.parts; i++) {

      const start = i * init.chunkSize;

      const end = Math.min(
        file.size,
        start + init.chunkSize
      );

      await req(
        '/api/upload/' + init.job + '/' + (i + 1),
        {
          method: 'PUT',
          body: file.slice(start, end)
        }
      );

      const uploadPercent =
        Math.round(end / file.size * 100);

      const pagePercent =
        Math.round(end / file.size * 45);

      $('bar').style.width =
        pagePercent + '%';

      $('msg').textContent =
        'Uploading MP4: ' +
        uploadPercent +
        '%';
    }


    //
    // FINISH R2 MULTIPART UPLOAD
    //

    await req(
      '/api/complete/' + init.job,
      {
        method: 'POST'
      }
    );


    $('msg').textContent =
      'Starting FFmpeg conversion...';


    //
    // MONITOR CONTAINER
    //

    while (true) {

      const s = await req(
        '/api/status/' +
        init.job +
        '?t=' +
        Date.now()
      );


      const conversionPercent =
        s.percent || 0;


      const overallPercent =
        45 +
        Math.round(
          conversionPercent * 0.55
        );


      $('bar').style.width =
        Math.min(
          overallPercent,
          100
        ) + '%';


      $('msg').textContent =
        (s.stage || 'working') +
        ': ' +
        conversionPercent +
        '% (' +
        (s.segments || 0) +
        ' segments uploaded)';


      if (s.error) {
        throw new Error(s.error);
      }


      if (s.done) {

        $('bar').style.width = '100%';

        const playlistURL =
          '/media/' +
          encodeURIComponent(init.username) +
          '/' +
          encodeURIComponent(init.folder) +
          '/playlist.m3u8';


        $('msg').innerHTML =
          'Complete: ' +
          '<a href="' +
          playlistURL +
          '">' +
          'playlist.m3u8' +
          '</a>';

        break;
      }


      await sleep(1500);
    }


  } catch (x) {

    $('err').textContent =
      x.message;

    $('msg').textContent =
      'Stopped';

  } finally {

    $('go').disabled = false;

  }

});

</script>

</body>
</html>`;
}


export default {

  async fetch(request, env) {

    const u = new URL(request.url);

    const p =
      u.pathname
        .split("/")
        .filter(Boolean);


    try {


      //
      // WEBPAGE
      //

      if (
        request.method === "GET" &&
        u.pathname === "/"
      ) {

        return new Response(
          page(),
          {
            headers: {
              "content-type":
                "text/html;charset=utf-8",
            },
          }
        );
      }


      //
      // INITIALIZE MULTIPART UPLOAD
      //

      if (
        request.method === "POST" &&
        u.pathname === "/api/init"
      ) {

        const b = await request.json();

        const username =
          safe(b.username);

        const folder =
          safe(b.folder);

        const filename =
          safe(
            String(b.filename)
              .replace(/\\.mp4$/i, "")
          ) +
          ".mp4";


        if (
          !username ||
          !folder ||
          !Number.isFinite(b.size) ||
          b.size < 1
        ) {

          return json(
            {
              error:
                "Invalid username, folder, or file",
            },
            400
          );
        }


        const job =
          crypto.randomUUID();


        const key =
          "_jobs/" +
          job +
          "/source.mp4";


        const mp =
          await env.MEDIA
            .createMultipartUpload(key);


        const parts =
          Math.ceil(
            b.size / CHUNK_SIZE
          );


        await env.MEDIA.put(
          "_jobs/" +
          job +
          "/meta.json",

          JSON.stringify({
            job: job,
            username: username,
            folder: folder,
            filename: filename,
            key: key,
            uploadId: mp.uploadId,
 
