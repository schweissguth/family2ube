# Cloudflare Worker + Container MP4 to HLS pipeline

This project serves an upload page from a Worker, uploads the MP4 to R2 in 8 MiB multipart chunks, starts one named Container per conversion job, runs FFmpeg at 480p with the `medium` preset and 60-second HLS segments, uploads each completed `.ts` segment immediately to R2, then publishes `playlist.m3u8`. The browser shows upload percentage, conversion percentage, segment count, completion, and errors.

## Output layout

For username `schweissguth`, folder `Blaze`, and file `My Movie.mp4`:

- `schweissguth/blaze/my-movie000.ts`
- `schweissguth/blaze/my-movie001.ts`
- `schweissguth/blaze/playlist.m3u8`

Username, folder, and source basename are normalized to lowercase URL-safe names.

## Prerequisites

1. A Cloudflare Workers Paid account with Containers enabled.
2. Node.js 20 or newer.
3. Docker available **on the machine used for deployment** because Wrangler builds and pushes the image. If Docker is blocked on your supervised PC, deploy from GitHub Actions or another machine with Docker.
4. An R2 bucket named `public`, or change `bucket_name` in `wrangler.jsonc`.

## Deploy locally

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Open the resulting `workers.dev` URL.

## Deploy with GitHub Actions when local Docker is unavailable

Create a repository, add these files, then add repository secrets:

- `CLOUDFLARE_API_TOKEN`: an API token that can edit Workers, Containers, Durable Objects, and R2.
- `CLOUDFLARE_ACCOUNT_ID`: your Cloudflare account ID.

The included workflow runs `wrangler deploy` on an Ubuntu runner with Docker.

## Operational notes

- Browser uploads are divided into 8 MiB requests, avoiding a single huge Worker request.
- The source MP4 is temporarily stored at `_jobs/<job-id>/source.mp4` and deleted after success.
- Job metadata/status remains under `_jobs/<job-id>/` for diagnostics. Add lifecycle cleanup if desired.
- `max_instances` is 5. A sixth simultaneous job waits/fails according to Cloudflare capacity; raise this after checking cost and account limits.
- The `standard-1` container size is selected for practical FFmpeg performance. Change `instance_type` if needed.
- This starter has no authentication. Before exposing it publicly, protect it with Cloudflare Access or add application authentication and quotas.
- For public playback from another website, configure the bucket/Worker CORS policy appropriately. The `/media/...` route sends `Access-Control-Allow-Origin: *`.
- R2 object keys are not the dashboard query string. The actual key is `username/folder/file.ts`; the dashboard may display it as `?prefix=username%2Ffolder%2F`.
