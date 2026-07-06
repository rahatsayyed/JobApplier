# Model auth & config — Claude Code with third-party models

## How Claude Code chooses the model

- **Normal Claude Code:** you run `/login` (Anthropic OAuth) or set `ANTHROPIC_API_KEY`, and it
  uses Anthropic's own models.
- **What JobApplier does:** Claude Code speaks the **Anthropic Messages format**, so it can talk to
  *any* compatible endpoint. When you set **`ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`**, Claude
  Code routes there and **skips interactive `/login`**. (You'll see a warning: *"claude.ai
  connectors are disabled because an auth source is set"* — that is expected and correct; it just
  means it's using our env, not your claude.ai login.)
- **Do not run `/login`** when using env-based third-party auth — it conflicts.

## The env vars

| Var | Meaning |
|---|---|
| `ANTHROPIC_BASE_URL` | the provider's Anthropic-compatible endpoint |
| `ANTHROPIC_AUTH_TOKEN` | the provider API key (sent as the auth header) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | main working model (most calls) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | small/fast subtasks |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | heaviest tasks |

Set all three tier vars so whatever tier Claude Code invokes resolves to a real provider model.

## Loading from `.env`

Claude Code does **not** auto-read `.env`. Load it into the shell first — this also passes the keys
to the MCP servers Claude Code spawns (they inherit its environment):

```bash
cd ~/Documents/Projects/personal/JobApplier
set -a && source .env && set +a
claude                       # interactive
claude -p "run the hunt"     # headless (cron/automation)
```

For cron/systemd, put `set -a; source /abs/path/.env; set +a` in the run script before `claude -p`.

## Provider A — OpenRouter / DeepSeek (default; needs a one-time ~$5 credit)

```
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-...
ANTHROPIC_DEFAULT_SONNET_MODEL=deepseek/deepseek-v4-flash
ANTHROPIC_DEFAULT_HAIKU_MODEL=deepseek/deepseek-v4-flash:free
ANTHROPIC_DEFAULT_OPUS_MODEL=deepseek/deepseek-v4-pro
```
OpenRouter blocks capable models (paid **and** the popular `:free` ones) until the account has
purchased credit at least once (~$5). Tiny ungated free models exist but are too weak to drive the
agent.

## Provider B — xAI / Grok (works on your existing xAI credits)

xAI's API is Anthropic-SDK compatible, so Claude Code uses it directly:

```
ANTHROPIC_BASE_URL=https://api.x.ai
ANTHROPIC_AUTH_TOKEN=<your xAI key>
ANTHROPIC_DEFAULT_SONNET_MODEL=grok-4-1-fast-reasoning
ANTHROPIC_DEFAULT_HAIKU_MODEL=grok-4-1-fast-reasoning
ANTHROPIC_DEFAULT_OPUS_MODEL=grok-4-1-fast-reasoning
```
`grok-4.1-fast` is cheap and strong at tool-calling. **Confirm on first run:** if requests 404,
the base URL may need to be `https://api.x.ai/v1`; if the model id is rejected, check the exact id
in the xAI console (e.g. `grok-4.1-fast`, `grok-4.3`).

## Switching providers cleanly

Keep the alternate provider in a **gitignored `.env.grok`** and source it *after* `.env` to override
just the model block:

```bash
set -a && source .env && source .env.grok && set +a && claude -p "run the hunt"
```

## Security

`.env` and `.env.grok` are gitignored — never commit keys.
