# Amuse

Self-hosted personal AI agent: it researches the web, uses a live browser you can watch and take
over, runs reminders and background checks, tracks goals and builds small apps you keep using, and
asks before it sends, submits or pays for anything. Amuse runs on your own computer for one person.
It needs an OpenAI API key and PostgreSQL. No account, hosted service or other API key is required.

## Features

- Chat with an agent you name and shape, with side chats for separate topics
- Web research with sources, using OpenAI web search
- A live browser in the chat that fills forms and navigates sites, which you can watch, take over or stop
- Reminders, monitors and a background heartbeat that only message you when something matters
- Goals turned into step-by-step plans that the agent keeps working on
- Documents, PDFs, images, podcasts and spaces: small apps with saved data
- Memory you can read and edit, stored as plain workspace files
- Approval cards for sends, form submissions, payments and new schedules, with once, task, site or always scopes
- An encrypted vault for logins and API keys; the model only sees stand-in tokens
- Voice mode with transcription and spoken replies
- Optional MCP servers (stdio or streamable HTTP), off by default, with approvals before their tools run

| Hatch your agent                     | Ask for an app, get a working one            |
| ------------------------------------ | -------------------------------------------- |
| ![Hatch](docs/media/hatch.gif)       | ![Build an app](docs/media/build-an-app.gif) |
| **It browses the web for you, live** | **Talk to it, and it talks back**            |
| ![Browser](docs/media/browser.gif)   | ![Voice mode](docs/media/voice.gif)          |

## Quick start with Docker Compose

Requirements: Docker Engine with the Compose plugin, Git, and an OpenAI API key.

```sh
git clone https://github.com/replit/amuse
cd amuse
cp .env.example .env    # then set OPENAI_API_KEY
docker compose up -d --build
```

Open **http://localhost:3000** and hatch your agent. Compose starts PostgreSQL alongside Amuse and
publishes the app on `127.0.0.1` only.

## From source

Use Node.js **22.9+**, pnpm **10.26.1** and PostgreSQL **14+**.

```sh
corepack enable
corepack prepare pnpm@10.26.1 --activate
pnpm install --frozen-lockfile
pnpm setup:browser      # downloads Chromium for the agent's live browser
cp .env.example .env    # set OPENAI_API_KEY and DATABASE_URL
pnpm build
pnpm start
```

Open **http://localhost:3000**. The server migrates its schema automatically before listening.

## Your OpenAI key

The agent (`gpt-6.2-sol`, with `gpt-6-luna` for quick steps), web search, image generation
(`gpt-image-2`), transcription and spoken replies all run on your OpenAI key. Set a spend limit on
your OpenAI project. Amuse also stops for the day at `AMUSE_DAILY_LIMIT` usage units (2,000 by
default) and pauses background jobs until the next day. Models and every other setting are in
[`.env.example`](.env.example).

Besides OpenAI, Amuse only contacts the sites the agent visits for you, any MCP servers you configure
and, for weather questions, the free [Open-Meteo](https://open-meteo.com/) API (weather data by
Open-Meteo.com, CC BY 4.0). Fonts and every other asset are served locally.

## MCP servers (optional)

Amuse can use tools from [MCP](https://modelcontextprotocol.io) servers. It's off unless
`AMUSE_MCP_CONFIG` points at a JSON file in the usual `mcpServers` shape:

```json
{
  "mcpServers": {
    "files": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/srv/notes"] },
    "tracker": { "url": "https://tracker.example/mcp", "headers": { "Authorization": "Bearer ${TRACKER_TOKEN}" } }
  }
}
```

A server has either a `command` (stdio, with optional `args`, `env` and `cwd`) or a `url` (streamable
HTTP, with optional `headers`). `${NAME}` in a value reads that environment variable, so tokens can
stay out of the file. Amuse starts or connects to every server when it starts, and offers their tools
to the agent as `mcp__<server>__<tool>`. A server that fails to start is logged and skipped.

Each MCP tool call shows an approval card first, with once, task or always scopes, because Amuse can't
know what a third-party tool does. If you trust a server to only read, add `"readOnly": true`: its
calls then follow the rules for reading connected services: allowed, unless Settings › Permissions ›
Connectors is set to Always ask. Results are treated as untrusted data, like web pages. `timeoutMs` sets
the per-call timeout (60 seconds by default).

Stdio servers run as the same user as Amuse and only get a minimal environment (`PATH`, `HOME` and
similar) plus their own `env`, never your OpenAI key. HTTP servers are contacted at the address you
configured, including local ones, so only add servers you trust. With Docker Compose, mount the
config file into the container, and note that stdio commands run inside the container.

## Scope

Amuse is deliberately small. It's a web app for one person on one computer, it uses OpenAI models
only, and it connects to services through API keys, its live browser and, if you configure them, MCP
servers.
Notifications appear while an Amuse tab is open; there's no push to your phone yet.

## Security model

Amuse is built for one person on their own computer, so it has **no login**. It listens on
`127.0.0.1` only and refuses changes from other sites. Don't expose it to a network or the internet.
The agent can only reach public internet addresses, saved credentials are only sent to the site you
confirmed, and consequential actions ask you first. See [SECURITY.md](SECURITY.md) for the full model
and [docs/AUDIT.md](docs/AUDIT.md) for licenses and checks.

With Docker Compose, the browser runs without Chromium's own sandbox, and the container is the
isolation boundary.

Expect approval cards: the agent asks before it opens sites you did not name, before payments, and
before it changes memory after it reads web content.

The encryption key for saved credentials is created on first run in `.data/secret.key` (or the
`amuse-data` Docker volume). Back it up together with your database; without it, saved credentials
can't be read.

## Development

```sh
pnpm dev                # API on :3000 and the web app with hot reload on http://localhost:5173
pnpm typecheck
pnpm test               # server unit tests; no database, network or API key needed
pnpm format             # Prettier
```

The end-to-end suite (`pnpm test:e2e`) drives a real browser through every flow against a fresh
database. It makes real model calls, so it spends API credits; see [CONTRIBUTING.md](CONTRIBUTING.md).

The code is a pnpm monorepo: `apps/server` (Express API and the agent), `apps/web` (React and Vite),
`lib/db` (Drizzle schema and migrations) and `tests/e2e` (Playwright).

CI (`.github/workflows/ci.yml`) runs the format check, typechecks, unit tests, a dependency audit, the
build, a Docker build and a secrets scan on every pull request.

See [Contributing](CONTRIBUTING.md), [Security](SECURITY.md) and the [Changelog](CHANGELOG.md).

## Acknowledgements

The workspace-file layout (`SOUL.md`, `IDENTITY.md`, `USER.md`, `AGENTS.md`, `MEMORY.md`,
`HEARTBEAT.md`, `BOOTSTRAP.md` and daily `memory/YYYY-MM-DD.md` notes) follows
[OpenClaw](https://github.com/openclaw/openclaw) (MIT).

## License

[Apache License 2.0](LICENSE). Third-party dependencies retain their own licenses.
Amuse is an independent project, not affiliated with or endorsed by OpenAI.
