<div align="center">
  <img src="public/brand/logo.png" alt="SQL Server Query AI" width="320" />

# SQL Server Query AI

**Understand the plan. Compare the options. Choose the next action.**

An AI workspace for SQL Server execution plans, with an OpenAI-compatible analyst and Jev as the decision engine.

[![Docker image](https://img.shields.io/badge/Docker_Hub-worlber%2Fsql--server--query--al-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/r/worlber/sql-server-query-al)
![Platform](https://img.shields.io/badge/container-linux%2Famd64-334155)
![Plan size](https://img.shields.io/badge/ShowPlan_XML-up_to_100_MB-0D9488)

[Quick start](#quick-start-with-docker) · [How it works](#how-it-works) · [Model setup](#configure-your-models) · [Privacy](#your-data-and-credentials) · [Development](#run-from-source)

</div>

## What it does

Upload a SQL Server execution plan and turn its evidence into a practical troubleshooting report. The analyst generates alternative remedies; **Jev evaluates those alternatives and selects a first action—or explicitly declines to choose when the evidence is insufficient**.

Each option includes its diagnosis, supporting evidence, prerequisites, suggested SQL, expected effect, validation steps, and rollback guidance. You review the recommendation and decide what to run. **The app does not connect to SQL Server or execute SQL.**

- **Large execution plans:** actual and estimated ShowPlan XML, multiple statements, and uploads up to 100,000,000 bytes.
- **Evidence per statement:** operators, runtime counters, estimate mismatches, warnings, waits, tables, and missing indexes.
- **Several remedies:** compare two to four options instead of relying on one generated answer.
- **Jev decisions:** evaluate fit, semantic safety, operational effort, and root-cause relevance, with separate evidence and safety checks.
- **A focused workspace:** light/dark themes, responsive sidebar, searchable history, account settings, SQL copy, and print/PDF export.
- **Saved work:** revisit reports or retry Jev using the existing evidence and alternatives.

## How it works

```mermaid
flowchart LR
    A[Upload ShowPlan XML] --> B[Select a statement]
    B --> C[Extract bounded evidence]
    C --> D[Analyst proposes alternatives]
    D --> E[Jev evaluates and compares]
    E --> F[Recommended action or abstention]
    F --> G[Review, validate, and apply yourself]
```

1. **Parse:** stream the XML to disk and parse it in a worker, keeping large files out of browser text fields.
2. **Focus:** select the statement to investigate. The highest estimated subtree cost is suggested; this is an estimate, not measured execution time.
3. **Propose:** send bounded statement evidence to your analyst model. It returns alternatives with evidence references and concrete next steps.
4. **Decide:** Jev checks evidence support and operational safety, scores the options, and chooses among eligible actions and an explicit no-action choice.
5. **Explain:** display the original candidate SQL and a structured action plan. A separate writing model cannot silently change the selected SQL.

Before any model is involved, **rule-based checks** flag known plan problems: key lookups, parameter sensitivity, oversized memory grants, tempdb spills, implicit conversions, residual predicates, bad row estimates, stale statistics, scalar UDFs and table variables. The analyst explains these findings instead of guessing. Each option's T-SQL is then **checked in code**: tables and columns must appear in the plan, index names must not already exist, and the SQL must be well-formed. Safety and effort for plain nonclustered indexes and statistics changes are set by rule; Jev judges the rest.

Every option comes with a **validation script**: a baseline with `SET STATISTICS IO, TIME`, the plan's parameter values, checks of existing indexes and statistics, the change, a re-measure, an `EXCEPT` result comparison for rewrites, Query Store history, and the rollback. After applying an option, upload the new plan under **Did it work?** to compare measured time, reads, memory and findings with the original.

If Jev abstains or is unavailable, the report shows **no selected winner**. Scores and confidence help explain the decision; they do not prove correctness or guarantee better database performance.

## Quick start with Docker

You need Docker Engine or Docker Desktop. The published image currently targets **Linux AMD64**. Other CPU architectures require compatible emulation or a source build; a native ARM64 image has not been published.

### 1. Pull the image

```bash
docker pull worlber/sql-server-query-al:latest
```

For a fixed release, use `worlber/sql-server-query-al:20260922` instead of `latest`.

### 2. Create a runtime secret

Run these commands once in a new deployment directory. Keep the generated file private and preserve it for future upgrades.

```bash
mkdir sql-server-query-ai
cd sql-server-query-ai
umask 077
printf 'APP_SECRET=%s\n' "$(openssl rand -hex 32)" > .env
```

`APP_SECRET` encrypts saved model credentials. **Do not regenerate it when restarting or upgrading an existing installation.** It belongs in your deployment environment, never in Git or a Docker image.

### 3. Start the container

```bash
docker volume create sql-server-query-ai-data

docker run -d \
  --name sql-server-query-ai \
  --restart unless-stopped \
  -p 3000:3000 \
  --env-file .env \
  -e DATA_DIR=/data \
  -v sql-server-query-ai-data:/data \
  worlber/sql-server-query-al:latest
```

Open **http://localhost:3000**. On a remote machine, replace `localhost` with its hostname or IP address.

The image starts with no accounts, provider keys, or analysis history. Create your account and complete the three-step setup guide.

### 4. Check the service

```bash
docker ps --filter name=sql-server-query-ai
docker logs --tail 100 sql-server-query-ai
curl -fsS http://localhost:3000/api/healthz
```

The health endpoint returns `{"ok":true}`. The container also has a built-in health check.

## Docker Compose

Clone this repository, then create a private `.env` containing a generated `APP_SECRET`, as shown above:

```bash
git clone https://github.com/ahmedalkhair64bit/sql-server-query-al.git
cd sql-server-query-al
umask 077
printf 'APP_SECRET=%s\n' "$(openssl rand -hex 32)" > .env

docker compose pull
docker compose up -d --no-build
```

The included Compose file uses the published, pinned image, exposes port 3000, and persists `/data` in a named volume. To select a different published tag, set `QAI_IMAGE` in `.env`:

```dotenv
QAI_IMAGE=worlber/sql-server-query-al:latest
```

To build from source instead:

```bash
docker compose up -d --build
```

## Configure your models

After signing up, the setup guide walks through three steps: what the app does, connecting both models, and a check that both actually answer. You can change everything later under **Settings → Models**. Each user has their own saved configuration.

| Field | What to enter |
| --- | --- |
| Provider | OpenAI, Azure OpenAI, Google Gemini, OpenRouter, Ollama, vLLM, or any other OpenAI-compatible API. Choosing one fills in the base URL. |
| Base URL | The API root, usually ending in `/v1`. It must be reachable from inside the container. |
| API key | Your provider key. For a local endpoint without authentication, enter any text, such as `EMPTY`. |
| Model | The exact model ID (for Azure, the deployment name). **Test analyst connection** lists the models your key can use. |
| Reasoning model switch | Turn on for Qwen3, DeepSeek-R1 and similar models served by vLLM or SGLang; otherwise the answer arrives empty. |
| Maximum response length | Leave empty for 4,096 tokens; raise it if answers are cut off. |
| Advanced request parameters | Optional JSON merged into every analyst request, such as `{"temperature":0.2}`. |
| TypeSafe API key | Your Jev key from [TypeSafe Console](https://console.typesafe.ai/keys). |
| Jev model | `jev-latest` unless you need a pinned version. |

Use the **Test** buttons before saving: each sends one tiny request and reports the real error (rejected key, unknown model, unreachable URL, timeout). The header shows **Models connected** only when both passed a test of the current settings. Inside a container, `localhost` refers to that container, not your host machine: use a reachable hostname, or `host.docker.internal` for services on the Docker host.

Saved keys are never shown again. **Leaving a key field empty keeps the saved key.** Provider keys are not passed as Docker build arguments.

**Privacy:** under Settings → Models you can stop sending the query text to the analyst model. Only plan evidence (operators, row counts, warnings, predicates, table and index names) is then sent, and query rewrites are not offered.

**Account and data:** changing your password requires the current one and signs out your other devices. Settings → Data exports every analysis as JSON, or deletes them all after you type `DELETE`.

## Analyze your first plan

1. In SQL Server Management Studio, save an actual or estimated execution plan as a `.sqlplan` file.
2. Choose **Upload a plan**, or paste ShowPlan XML for a small plan.
3. If the file contains several statements, select the one you want to investigate.
4. Add optional context: what is slow, what changed, and constraints on making changes.
5. Select **Analyse plan** and review the evidence, alternatives, and Jev decision.
6. Check prerequisites, validate the proposed SQL in your environment, and keep the rollback guidance available.

You can stop a running analysis, reopen saved reports, rename or delete history entries, copy SQL, and use **Export to PDF** through your browser's print dialog.

## Your data and credentials

| Data | Where it goes |
| --- | --- |
| Accounts, sessions, and saved reports | SQLite in your data volume. |
| Uploaded XML and statement indexes | Files under `/data/plans` in Docker. |
| Provider API keys | Encrypted with AES-256-GCM in SQLite using your runtime `APP_SECRET`. |
| Model input | Bounded evidence, SQL text, object names, and your context note sent to the configured analyst and Jev services. |

**Bounded does not mean anonymized.** Plan evidence and SQL can contain sensitive schema names, literals, or business context. Use providers appropriate for your data. The original XML file is not sent wholesale to the models.

This public repository and the published image exclude deployment secrets, real databases, user sessions, analyzed production plans, and QA recordings. The one included plan fixture is synthetic and exists for automated tests. Internal development history containing runtime data is not part of this repository.

For an internet-facing installation, place the app behind HTTPS and appropriate network/access controls. Signup is available to anyone who can reach the app; this release does not include a registration allowlist or built-in rate limiting. The container runs as a non-root user.

## Persistence, backup, and upgrades

Back up **both the entire data volume and the matching `APP_SECRET`**. Losing the secret makes saved model keys unreadable. A stopped-container or otherwise consistent volume backup is preferable to copying a live SQLite file alone.

For Compose upgrades:

```bash
# Keep the existing .env and named volume.
docker compose pull
docker compose up -d --no-build
docker compose ps
```

For `docker run` installations, pull the chosen tag, stop and remove the old container, and repeat the start command with the **same volume and environment file**. Removing a container does not remove its named volume.

Do not use `docker compose down -v` unless you intend to delete the application's stored data.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_SECRET` | Required | At least 16 characters; use a strong randomly generated value. |
| `DATA_DIR` | `./data` locally; `/data` in Docker | Database, uploads, and statement indexes. |
| `PORT` | `3000` | Application listening port. |
| `COOKIE_SECURE` | Unset | Set to `1` for direct HTTPS if the proxy does not supply `X-Forwarded-Proto`. Leave unset for plain local HTTP. |
| `QAI_IMAGE` | Published `20260922` tag | Compose image selection; not an application setting. |

## Supported plans and limits

- SQL Server actual and estimated ShowPlan XML in `.sqlplan` or `.xml` files.
- Batch and nested statements; analyze one statement at a time.
- UTF-8, UTF-16LE/BE, and UTF-32LE/BE with BOM detection and common XML signatures.
- Maximum **100,000,000 bytes**, 100,000 statements, and 20,000 nested tags.
- Two ingestion workers at once, each with a 512 MB heap budget and a 120-second parsing deadline.
- Text SHOWPLAN, screenshots, and other database formats are not supported. DTDs and external entities are rejected.

Long SQL and truncated evidence are explicitly marked. Incomplete statement text cannot receive a rewrite recommendation. Deleting the last analysis referencing an upload removes its files; unused uploads older than 24 hours are cleaned during the owner's next upload.

## Run from source

Use **Node.js 24.10+** and npm. Node 24 is the container runtime; the app uses `node:sqlite`.

```bash
git clone https://github.com/ahmedalkhair64bit/sql-server-query-al.git
cd sql-server-query-al
npm ci
cp .env.example .env.local
```

Replace the placeholder `APP_SECRET` in `.env.local` with a random secret, then:

```bash
npm run dev

# Production build
npm run build
npm start
```

## Tests and project structure

```bash
npm test
npm run lint
npm run build
npx playwright install --with-deps chromium firefox webkit
npm run e2e
npm run benchmark:plans
```

Before publishing an image, run the API stress suite against it. It uses controlled providers and a throwaway data directory: concurrent analyses, large uploads, provider faults, disconnects and a double-clicked retry.

```bash
docker build -t qai:test .
npm run stress:api -- --docker qai:test
```

Default browser tests use isolated `.playwright-data` storage and controlled provider responses. Live integration tests require `JEV_API_KEY`, `QAI_ANALYST_BASE_URL`, and `QAI_ANALYST_MODEL`, plus any provider-specific key or extra parameters, in your local environment. Build first, then run `npm run e2e:live`. Do not commit the credentials.

The deployed release passed 43 browser regression cases across Chromium, Firefox, WebKit, and mobile, plus live analyst/Jev and restart-persistence checks. A server-local 100 MB upload/indexing probe took approximately 3.5 seconds; results depend on hardware and network conditions.

```text
app/           Pages and API routes
components/    Workspace, account forms, and structured reports
lib/           Plan parser, analyst, Jev decisions, auth, and storage
public/brand/  Application logo
fixtures/      Synthetic test plan
scripts/       Test providers and parser benchmarks
tests/         Unit tests
tests-e2e/     Playwright browser tests
```

Built with Next.js, React, SQLite, a streaming XML parser, and the TypeSafe SDK.

### Measuring recommendation quality

`fixtures/eval/` holds plans with known answers. `npm test` checks that the rule-based findings detect each problem. To measure the models themselves:

```bash
ANALYST_BASE_URL=https://api.example.com/v1 ANALYST_API_KEY=... ANALYST_MODEL=... \
JEV_API_KEY=... npm run eval:plans
```

It reports how often Jev picks a correct fix type, and declines on the healthy plan.

To test Jev on its own, without an analyst key, `JEV_API_KEY=... npm run eval:jev` gives the real Jev a fixed set of options per plan: one correct fix, a plausible decoy, and sometimes a risky option such as NOLOCK or a rewrite that changes results. Measured on 2026-09-25 with `jev-latest`: correct on 16 of 17 plans. It declined on the healthy plan, picked "find the blocker" over an index on the blocking plan, and flagged every risky option. The one miss (parallel skew) was a decline: Jev judged the "investigate the skew" option as not well supported by the evidence. Add your own anonymized plans to `fixtures/eval/private/` (gitignored) with a `cases.json` in the same shape. `npm run eval:plans -- --outcomes data/qai.db` reports real outcomes from saved before/after comparisons.

Full pipeline, measured on 2026-09-25 with DeepSeek V4-Pro as the analyst (maximum response length 32,000) and `jev-latest`, on 22 plans. The latest full run scored 18 of 22 (82%); the run before it scored 14 of 22 with the same code, so single runs vary by several plans. The analyst proposed a correct option on all 22. A read-only diagnostic on system views is now judged safe by rule, which fixed blocking-waits on re-run. The two plans that still fail on re-runs are genuine disagreements: on row-goal Jev prefers a statistics update over the rewrite or index, and on unmatched-filtered-index it prefers a new covering index over fixing the parameterization that stops the existing filtered index being used. Reasoning models like DeepSeek take 2 to 5 minutes per analysis.
