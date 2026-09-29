# Mineravix Pulse

Frontend: `index.html` (GitHub Pages). Backend: Cloudflare Worker `mineravix-proxy` in [`worker/`](worker/), proxying AI requests to the Claude API. The API key lives only as a Cloudflare secret, never in this repo.

## Worker: deploy

Requires Node.js and a Cloudflare login (`npx wrangler login`).

```bash
cd worker
bash scripts/check.sh                   # must print ALL CHECKS PASSED
npx wrangler secret put CLAUDE_API_KEY  # paste the key when prompted (first time / rotation)
npx wrangler deploy
```

**Order matters on the first deploy from git:** the live Worker used to read the secret `ANTHROPIC_API_KEY`. Run `wrangler secret put CLAUDE_API_KEY` *before* `wrangler deploy`, otherwise every AI request fails. After the new version is confirmed working, remove the old secret:

```bash
npx wrangler secret delete ANTHROPIC_API_KEY
```

## Worker: local dev

```bash
cd worker
cp .dev.vars.example .dev.vars   # put the real key in .dev.vars (gitignored, never commit)
npx wrangler dev
```

## Rules

- Never commit `.dev.vars` or any `sk-ant-` string.
- Editing code in the Cloudflare dashboard makes git stale. Change code here, then deploy with wrangler.
