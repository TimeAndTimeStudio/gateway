# Starling GitHub Build Gateway (Node.js)

A Node.js implementation of the GitHub Actions path used by Starling's native-mod build gateway. It exposes the Starling HTTP routes and dispatches `starling-client/mod-builds` workflow `build.yml`.

## Important limitations

- This is a GitHub-only gateway. It does not host `mod_build_server.py`, the Linux/Android SDK build machine, or the native build sandbox. All requests sent to `/v1/build` are routed to GitHub Actions.
- It requires the public `starling-client/mod-builds` repository to have the matching `build.yml` workflow and a prepared cache in `versions.json` for the requested Starling version. A workflow dispatch alone cannot build a version whose base cache has not been prepared.
- Render must use a paid service with a persistent disk. Do not use a free instance: its filesystem is ephemeral and may sleep.
- Native mods execute code during compilation and the resulting native library runs inside the game process. Only use mods you trust.

## Deploy

1. Push this folder to a new GitHub repository (include all files in this folder).
2. In Render choose **New > Blueprint** and select that repository.
3. After Render creates the service, set `GATEWAY_PUBLIC_URL` to the exact public service URL, for example `https://starling-github-gateway.onrender.com` (no trailing slash).
4. Set `GITHUB_TOKEN` to a fine-grained GitHub PAT restricted to `starling-client/mod-builds`, with:
   - Actions: Read and write
   - Contents: Read-only
   - Metadata: Read-only
5. Redeploy. Check `https://YOUR-SERVICE.onrender.com/healthz` and expect `{"ok":true}`.
6. In Starling > Mods > Build server..., enter the HTTPS service URL.

## Environment variables

- `GITHUB_TOKEN` — required fine-grained PAT. Keep it only in Render Environment; never commit it.
- `GATEWAY_PUBLIC_URL` — required public HTTPS URL used by GitHub runners to fetch the submitted mod bundle.
- `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_REF`, `GITHUB_WORKFLOW` — defaults target `starling-client/mod-builds`, branch `main`, workflow `build.yml`.
- `STORE_DIR` — persistent state directory; Render Blueprint sets `/var/data/starling`.
- `MAX_ACTIVE` / `MAX_QUEUE` — concurrency and queue caps.

## Local checks

```sh
npm install
GITHUB_TOKEN=... GATEWAY_PUBLIC_URL=http://localhost:10000 STORE_DIR=./data npm start
curl http://localhost:10000/healthz
```

The Starling client sends binary build requests to `POST /v1/build?version=...`; the gateway serves job status at `GET /v1/job/:job`, the library at `GET /v1/job/:job/lib`, and the runner's uploaded mod bundle at `GET /v1/github/:ask`.
