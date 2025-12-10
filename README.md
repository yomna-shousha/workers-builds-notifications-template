# Cloudflare Workers Builds → Slack Notifications

A Cloudflare Worker that consumes [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) events from a [Queue](https://developers.cloudflare.com/queues/) and sends status notifications to Slack

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/yomna-shousha/workers-builds-queue-subscriptions)

## Features

| Event | Notification |
|-------|--------------|
| ✅ Build succeeded (production) | Live Worker URL |
| ✅ Build succeeded (preview) | Preview URL |
| ❌ Build failed | Build logs inline |
| ⚠️ Build cancelled | Build logs inline |
| 🚀 Build started | Build started |

---

### 1. Deploy the Worker

#### Option A: Via Dashboard

1. Go to [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages) → **Create** → **Import a repository**
2. Connect your GitHub/GitLab and select this repository
3. Deploy

#### Option B: Via CLI

```bash
git clone https://github.com/YOUR_USERNAME/workers-builds-queue-subscriptions.git
cd workers-builds-queue-subscriptions
npm install
wrangler deploy
```

---

### 2. Create a Slack Webhook

1. Go to [Slack Apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Name it (e.g., "Workers Builds Notifications") and select your workspace
3. Go to **Incoming Webhooks** → Toggle **On**
4. Click **Add New Webhook to Workspace** → Select your channel
5. Copy the webhook URL

---

### 3. Create a Cloudflare API Token

1. Go to [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Select **Edit Cloudflare Workers** template
4. Click **Continue to summary** → **Create Token**
5. Copy the token

---

### 4. Set Secrets

#### Option A: Via Dashboard

1. Go to [Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages)
2. Select your deployed worker
3. Go to **Settings** → **Variables and Secrets**
4. Add:
   - `SLACK_WEBHOOK_URL` → Your Slack webhook URL
   - `CLOUDFLARE_API_TOKEN` → Your API token

#### Option B: Via CLI

```bash
wrangler secret put SLACK_WEBHOOK_URL
# Paste your Slack webhook URL

wrangler secret put CLOUDFLARE_API_TOKEN
# Paste your API token
```

---

### 5. Create a Queue

#### Option A: Via Dashboard

1. Go to [Queues](https://dash.cloudflare.com/?to=/:account/workers/queues)
2. Click **Create Queue**
3. Name it `builds-event-subscriptions` (or your preferred name)
4. Click **Create**

#### Option B: Via CLI

```bash
wrangler queues create builds-event-subscriptions
```

> **Important:** The queue name must match what's in `wrangler.jsonc`:
> ```jsonc
> "queues": {
>   "consumers": [
>     {
>       "queue": "builds-event-subscriptions",  // ← Must match your queue name
>       ...
>     }
>   ]
> }
> ```
> If you use a different queue name, update `wrangler.jsonc` and redeploy.

---

### 6. Create an Event Subscription

Subscribe your queue to Workers Builds events.

#### Option A: Via Dashboard

1. Go to [Queues](https://dash.cloudflare.com/?to=/:account/workers/queues)
2. Select your queue (`builds-event-subscriptions`)
3. Go to the **Subscriptions** tab
4. Click **Subscribe to events**
5. Select source: **Workers Builds**
6. Select events: All (or specific ones)
7. Click **Subscribe**

#### Option B: Via CLI

```bash
wrangler queues subscription create builds-event-subscriptions \
  --source workers-builds \
  --events build.started,build.succeeded,build.failed
```

> For more details, see [Event Subscriptions Documentation](https://developers.cloudflare.com/queues/event-subscriptions/manage-event-subscriptions/)

---

### 7. Test It!

Trigger a build on any worker in your account. You should see a notification in Slack within seconds!

---

## How It Works

```
┌─────────────────┐     ┌─────────────┐     ┌──────────────────┐     ┌─────────┐
│ Workers Builds  │────▶│   Queue     │────▶│ This Consumer    │────▶│  Slack  │
│ (any worker)    │     │             │     │ Worker           │     │         │
└─────────────────┘     └─────────────┘     └──────────────────┘     └─────────┘
```

1. **Any worker** in your account triggers a build
2. **Workers Builds** publishes an event to your **Queue**
3. **This consumer worker** processes the event and sends a **Slack** notification

---

## Event Schema

```json
{
  "type": "cf.workersBuilds.worker.build.succeeded",
  "source": {
    "type": "workersBuilds.worker",
    "workerName": "my-worker"
  },
  "payload": {
    "buildUuid": "build-12345678-90ab-cdef-1234-567890abcdef",
    "status": "stopped",
    "buildOutcome": "success",
    "createdAt": "2025-05-01T02:48:57.132Z",
    "stoppedAt": "2025-05-01T02:50:15.132Z",
    "buildTriggerMetadata": {
      "buildTriggerSource": "push_event",
      "branch": "main",
      "commitHash": "abc123def456",
      "commitMessage": "Fix bug in authentication",
      "author": "developer@example.com",
      "repoName": "my-worker-repo",
      "providerType": "github"
    }
  },
  "metadata": {
    "accountId": "your-account-id",
    "eventTimestamp": "2025-05-01T02:48:57.132Z"
  }
}
```

### Event Types

| Event Type | Description |
|------------|-------------|
| `cf.workersBuilds.worker.build.started` | Build has started |
| `cf.workersBuilds.worker.build.succeeded` | Build completed successfully |
| `cf.workersBuilds.worker.build.failed` | Build failed |
| `cf.workersBuilds.worker.build.failed` + `buildOutcome: "cancelled"` | Build was cancelled |

---

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `SLACK_WEBHOOK_URL` | Slack incoming webhook URL |
| `CLOUDFLARE_API_TOKEN` | API token with Workers Builds and Scripts read access |

### Queue Settings (wrangler.jsonc)

| Setting | Default | Description |
|---------|---------|-------------|
| `max_batch_size` | 10 | Messages per batch |
| `max_batch_timeout` | 30 | Seconds to wait for full batch |
| `max_retries` | 3 | Retry attempts for failed processing |

---

## Troubleshooting

### No notifications appearing

1. **Check the queue**: Dashboard → Queues → Your queue (are messages arriving?)
2. **Check worker logs**: Dashboard → Workers → Your consumer worker → Logs
3. **Verify subscription**: Dashboard → Queues → Your queue → Subscriptions tab

### "Invalid token" error in logs

- Verify `CLOUDFLARE_API_TOKEN` is set in worker settings
- Ensure token has correct permissions (Edit Cloudflare Workers template)

### URLs not appearing

- **Preview URL missing**: Build was for main/master branch (shows Live URL instead)
- **Live URL missing**: Check token has correct permissions
