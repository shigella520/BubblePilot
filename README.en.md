<p align="center">
  <img src="assets/brand/bubblepilot-icon.png" width="128" alt="BubblePilot icon" />
</p>

<h1 align="center">BubblePilot</h1>

<p align="center">
  <strong>English</strong> ·
  <a href="README.md">简体中文</a> ·
  <a href="README.zh-TW.md">繁體中文</a>
</p>

<p align="center">
  <strong>Put your BlueBubbles conversations on autopilot.</strong>
</p>

<p align="center">
  A self-hosted BlueBubbles message archive, workflow automation, and AI bot platform.
</p>

<p align="center">
  <a href="#first-working-automation-in-10-minutes">Quick setup</a> ·
  <a href="doc/部署与运维.md">Deployment and operations</a> ·
  <a href="doc/README.md">Documentation</a>
</p>

<p align="center">
  <a href="https://github.com/shigella520/BubblePilot/actions/workflows/ci.yml"><img src="https://github.com/shigella520/BubblePilot/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT License" /></a>
  <a href="https://www.docker.com/"><img src="https://img.shields.io/badge/Docker_Compose-ready-2496ED?logo=docker&logoColor=white" alt="Docker Compose" /></a>
  <a href="https://www.postgresql.org/"><img src="https://img.shields.io/badge/PostgreSQL-16-4169E1?logo=postgresql&logoColor=white" alt="PostgreSQL 16" /></a>
</p>

BubblePilot receives new-message events from BlueBubbles, archives only the chats you choose, matches triggers, and runs visual workflows. A workflow can load recent conversation context, call one or more OpenAI-compatible providers, search the web when needed, and safely reply to the original chat.

- **Selective archiving:** unmonitored chats keep only the minimum metadata needed for discovery; message bodies are not archived.
- **Explainable automation:** inbound decisions, nodes, AI attempts, search tools, and outgoing delivery states are traceable in the Web UI.
- **No single AI dependency:** providers can Retry and Fallback in a fixed order, with automatic degradation after repeated failures.
- **Your instance owns the data:** PostgreSQL is authoritative for messages, configuration, executions, and audit records.

## What you can build

| Use case | BubblePilot capability |
| --- | --- |
| Archive important conversations | Enable monitoring per chat, search archived messages, and export an authorized JSON Lines snapshot |
| Create a group-chat bot | Trigger on chat, sender, content type, keyword, prefix, regex, or time window |
| Design message workflows | Connect context, condition, variable, AI, reply, and end nodes on a visual canvas |
| Use multiple AI services | Manage OpenAI-compatible providers and routes with Retry, Fallback, degradation, and recovery |
| Answer with current web information | Use provider-hosted search or Function Calling with the bundled private SearXNG service |
| Diagnose failures | Inspect executions, node traces, provider attempts, tool calls, and outgoing delivery state |

Web search is optional. With it disabled, archiving, regular workflows, and non-search AI replies continue to work.

## How it works

![BubblePilot architecture](doc/architecture-overview.svg)

BlueBubbles remains the iMessage gateway. BubblePilot owns its monitoring rules, archive, workflows, execution history, and audit facts. Every message is normalized and deduplicated before matching, so a webhook redelivery cannot create a duplicate reply.

![BubblePilot message workflow](doc/message-workflow-flow.svg)

## Product preview

The workflow canvas is shown on the left; the complete node, AI provider, web-search, and outgoing-delivery trace is shown on the right. Click the image to view it at full resolution.

[![BubblePilot workflow canvas and execution trace](assets/preview/bubblepilot-usage.png)](assets/preview/bubblepilot-usage.png)

## First working automation in 10 minutes

A healthy container is only the first step. Complete the BlueBubbles, webhook, chat monitoring, AI route, and workflow steps in this order.

### Prerequisites

- A working [BlueBubbles Server](https://bluebubbles.app/) with its Server URL and REST API Password.
- A Linux host, NAS, or server with Git, Docker Engine, and Docker Compose v2.
- A webhook address that the BlueBubbles Server can reach. Use HTTPS on the public Internet or a controlled private network.
- For AI workflows, an OpenAI-compatible Base URL, model name, and API key.

### Recommended: let Codex assist with deployment

BubblePilot requires two management passwords, several independent secrets, a BlueBubbles webhook, a reverse proxy, chat monitoring, and an optional AI route. A container can be healthy while the product is still unusable, so using Codex App or Codex CLI to plan, configure, and verify the deployment is recommended.

Open this repository in Codex, or connect it to an SSH host that already has key-based access, then adapt this example:

```text
Deploy BubblePilot to the server below. First read AGENTS.md, README.md,
doc/部署与运维.md, and .env.example. Show me the plan and missing information
before making changes.

Server:
- OS: Ubuntu 24.04 amd64
- SSH: deploy@bubblepilot.example.com:22 (key-based access is configured)
- Deployment directory: /opt/bubblepilot
- Public URL: https://bubblepilot.example.com
- Reverse proxy: Caddy, already installed
- Docker Engine and Docker Compose v2 are installed
- Build from the current repository source

BlueBubbles:
- Server URL: http://192.0.2.10:1234
- Ask me to enter the REST API Password in a controlled terminal when needed
- Discover the initial Chat GUID from the first webhook

Preferences:
- Retain message bodies for 90 days
- Enable web search
- AI API kind: OpenAI-compatible Responses API
- AI Base URL: https://api.example.com/v1
- Model: example-model
- Ask me to enter the API key in a controlled terminal when needed

Requirements:
1. Check OS, ports, DNS, HTTPS, Docker, and directory permissions first.
2. Generate every random secret independently and write it directly to a
   permission-restricted .env without printing it in replies or normal logs.
3. Pause for secure terminal input when the two different management passwords,
   BlueBubbles password, or AI key are needed. Store only password hashes.
4. Never ask me to paste an SSH private key, password, token, or API key into chat.
5. Configure HTTPS, disable webhook query-string logging, and do not expose
   PostgreSQL or SearXNG.
6. Validate Compose, start the stack, and check /health/ready.
7. Test BlueBubbles REST and return the webhook URL I must configure.
8. Do not enable chat monitoring, production workflows, or deletion without
   my explicit confirmation.
9. Finish with completed work, remaining Web UI steps, validation, and rollback.

Done when HTTPS login works, all containers are healthy, BlueBubbles REST works,
the webhook URL is ready, and no secret was printed. Wait for my confirmation
before enabling monitoring, the AI route, or the first workflow.
```

All addresses and accounts above are fictional. Codex can inspect the host, generate configuration, start services, validate health, and configure the proxy; you should still confirm real credentials and every action that enables production data collection or automation. Continue below for the manual method.

### 1. Download BubblePilot

```bash
git clone https://github.com/shigella520/BubblePilot.git
cd BubblePilot
cp .env.example .env
```

### 2. Generate secrets and password hashes

Generate a different random value for each setting:

```bash
for key in POSTGRES_PASSWORD API_ACCESS_TOKEN SETTINGS_ENCRYPTION_KEY BLUEBUBBLES_WEBHOOK_SECRET SEARXNG_SECRET; do
  printf '%s=' "$key"
  openssl rand -hex 32
done
```

The login password and sensitive-operation password must be different. Run the following command twice and save the final `scrypt$...` line from each run:

```bash
printf 'Password (input is hidden): ' >&2
IFS= read -r -s BUBBLEPILOT_PLAIN_PASSWORD
printf '\n' >&2
printf '%s' "$BUBBLEPILOT_PLAIN_PASSWORD" | \
  docker compose run --rm --no-deps --build --entrypoint node app dist/app/hash-password.js
unset BUBBLEPILOT_PLAIN_PASSWORD
```

### 3. Complete `.env`

Replace every `CHANGE_ME` value. The minimum required settings are:

| Setting | Value |
| --- | --- |
| `POSTGRES_PASSWORD` | The generated database password |
| `DATABASE_URL` | The same database password inside the connection string |
| `API_ACCESS_TOKEN` | A unique random management API compatibility token |
| `SETTINGS_ENCRYPTION_KEY` | A unique stable key used to encrypt runtime credentials in PostgreSQL |
| `BLUEBUBBLES_WEBHOOK_SECRET` | A unique random value used in the webhook URL |
| `BLUEBUBBLES_SERVER_URL` | The BlueBubbles root URL, for example `http://192.0.2.10:1234` |
| `BLUEBUBBLES_ACCESS_TOKEN` | The BlueBubbles REST API Password |
| `APP_LOGIN_PASSWORD_HASH` | The first hash, enclosed in single quotes |
| `SENSITIVE_OPERATION_PASSWORD_HASH` | The second, different hash, enclosed in single quotes |
| `SEARXNG_SECRET` | A unique random value, required even while search is disabled |

The password hashes contain `$`, so keep the single quotes:

```dotenv
APP_LOGIN_PASSWORD_HASH='scrypt$...'
SENSITIVE_OPERATION_PASSWORD_HASH='scrypt$...'
```

Optional settings:

- `MONITORED_CHAT_IDS`: comma-separated Chat GUIDs to monitor from the first event. If empty, discover chats through the webhook and enable them in the Web UI.
- `MESSAGE_RETENTION_DAYS`: archived bodies and attachment metadata are kept for 90 days by default. `0` explicitly accepts indefinite retention.
- `ENABLE_WEB_SEARCH`: defaults to `false` and acts as the deployment-level safety switch. Once enabled, manage retries, timeouts, result limits, and failure fallback from the AI page's global Web Search settings; saved changes apply immediately.
- `BUBBLEPILOT_IMAGE`: source deployments build locally. For a release deployment, pin `ghcr.io/shigella520/bubblepilot:1.0.0` instead of relying on `dev` or `latest`.

### 4. Start and check the stack

```bash
docker compose config
docker compose up -d --build
docker compose ps
curl --fail http://127.0.0.1:8080/health/ready
```

Only the Web application is bound to `127.0.0.1:8080`. PostgreSQL and SearXNG are not exposed to the host. Put Nginx, Caddy, or a controlled tunnel in front of BubblePilot before exposing it.

Open `http://127.0.0.1:8080` or your HTTPS domain and sign in with the original login password. Viewing messages, changing monitoring, and editing system settings require the separate sensitive-operation password.

### 5. Connect BlueBubbles

1. In BubblePilot, open **Settings**, complete sensitive verification, confirm the Server URL, token, and send method, then test the connection.
2. In BlueBubbles Server, create a webhook subscribed to `New Messages`.
3. Use this webhook URL:

```text
https://bubblepilot.example.com/api/v1/webhooks/bluebubbles?token=<BLUEBUBBLES_WEBHOOK_SECRET>
```

4. Send a test message from another account. If `MONITORED_CHAT_IDS` is empty, this first event discovers the chat without archiving its body.
5. Open **Messages** in BubblePilot, unlock sensitive actions, enable the chat, and send a second test message.

Disable query-string access logging for this webhook path. The secret is carried in the URL because BlueBubbles does not add a custom signing header.

### 6. Configure an AI provider (optional)

1. Open **AI Provider** and add the API kind, Base URL, model, API key, and timeout.
2. Enable Function Calling or hosted search only when the provider supports it, then run the connection and capability tests.
3. Create a provider route with its candidate order, Fallback, Retry, degradation threshold, and cooldown.
4. For web search, set `ENABLE_WEB_SEARCH=true` and confirm that the page reports the search backend as ready.

The API key is encrypted in PostgreSQL with `SETTINGS_ENCRYPTION_KEY` and is never returned by the UI, API, or logs.

### 7. Create the first workflow

Create a workflow and connect this minimal AI reply graph:

```text
Message Trigger → Load Context → AI Chat → Reply → End
```

1. Select a monitored chat in **Message Trigger**, set a keyword or prefix, and enable the trigger node.
2. Add **Render Text** when fixed instructions, the current event, and upstream outputs must be combined; insert allowed Context values in its template editor.
3. Select the provider route in **AI Chat** and set its prompt, output limits, and web-search policy.
4. Connect `AI Chat.text` to `Reply.text`, then connect the control edges.
5. Save and enable the workflow, send a matching message, and inspect **Executions** for the complete result.

**Render Text** supports controlled references such as `{{context.event.message.text}}`, `{{context.event.message.senderId}}`, and `{{context.outputs.<node-id>.<output-port>}}`.

For a fixed reply, use `Message Trigger → Reply → End` and skip AI configuration.

## Production checklist

- Use HTTPS or a controlled private network for BubblePilot and BlueBubbles traffic.
- Do not expose PostgreSQL or SearXNG, and do not log the webhook query string.
- Store `.env`, backups, and `SETTINGS_ENCRYPTION_KEY` securely; never rotate the encryption key accidentally during an upgrade.
- Review chat monitoring, message retention, and AI context limits.
- Back up PostgreSQL and deploy an exact image version before upgrading.

The detailed Chinese guides cover [deployment and operations](doc/部署与运维.md), [technical design](doc/技术设计.md), [workflow semantics](doc/事件与工作流设计.md), and [API/configuration contracts](doc/接口与配置契约.md).

## License

BubblePilot is released under the [MIT License](LICENSE).
