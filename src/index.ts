/**
 * Cloudflare Workers Builds → Slack Notifications
 *
 * This worker consumes build events from a Cloudflare Queue and sends
 * notifications to Slack with:
 * - Preview/Live URLs for successful builds
 * - Full build logs for failed/cancelled builds
 *
 * @see https://developers.cloudflare.com/workers/ci-cd/builds
 * @see https://developers.cloudflare.com/queues/
 * @see https://developers.cloudflare.com/queues/event-subscriptions/
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

export interface Env {
  SLACK_WEBHOOK_URL: string;
  CLOUDFLARE_API_TOKEN: string;
}

interface CloudflareEvent {
  type: string;
  source: {
    type: string;
    workerName?: string;
  };
  payload: {
    buildUuid: string;
    status: string;
    buildOutcome: 'success' | 'fail' | 'cancelled' | null;
    createdAt: string;
    initializingAt?: string;
    runningAt?: string;
    stoppedAt?: string;
    buildTriggerMetadata?: {
      buildTriggerSource: string;
      branch: string;
      commitHash: string;
      commitMessage: string;
      author: string;
      buildCommand: string;
      deployCommand: string;
      rootDirectory: string;
      repoName: string;
      providerAccountName: string;
      providerType: string;
    };
  };
  metadata: {
    accountId: string;
    eventSubscriptionId: string;
    eventSchemaVersion: number;
    eventTimestamp: string;
  };
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

function getBuildDuration(event: CloudflareEvent): string | null {
  const start = event.payload?.createdAt;
  const end = event.payload?.stoppedAt;
  if (!start || !end) return null;
  
  const durationMs = new Date(end).getTime() - new Date(start).getTime();
  const seconds = Math.floor(durationMs / 1000);
  
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

function getCommitUrl(event: CloudflareEvent): string | null {
  const meta = event.payload?.buildTriggerMetadata;
  if (!meta?.repoName || !meta?.commitHash || !meta?.providerAccountName) return null;
  
  if (meta.providerType === 'github') {
    return `https://github.com/${meta.providerAccountName}/${meta.repoName}/commit/${meta.commitHash}`;
  }
  if (meta.providerType === 'gitlab') {
    return `https://gitlab.com/${meta.providerAccountName}/${meta.repoName}/-/commit/${meta.commitHash}`;
  }
  return null;
}

function isProductionBranch(branch: string | undefined): boolean {
  if (!branch) return true;
  return ['main', 'master', 'production', 'prod'].includes(branch.toLowerCase());
}

function truncateCommitMessage(message: string | undefined): string {
  if (!message) return '';
  const firstLine = message.split('\n')[0].trim();
  return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
}

function extractBuildError(logs: string[]): string {
  if (!logs || logs.length === 0) {
    return 'No logs available';
  }

  const lastLines = logs.slice(-30);
  const errorIndicators = [
    'ERROR:', 'Error:', 'error:',
    'FAILED:', 'Failed:', 'failed:',
    'error TS', 'SyntaxError', 'ReferenceError',
    'Module not found', 'Cannot find module',
    'Build failed', 'Compilation failed',
  ];

  let errorStartIdx = -1;
  for (let i = lastLines.length - 1; i >= 0; i--) {
    if (errorIndicators.some((indicator) => lastLines[i]?.includes(indicator))) {
      errorStartIdx = i;
      break;
    }
  }

  if (errorStartIdx >= 0) {
    const errorLines = lastLines.slice(errorStartIdx, errorStartIdx + 8);
    const errorText = errorLines.join('\n').trim();
    return errorText.length > 800 ? errorText.substring(0, 800) + '\n...' : errorText;
  }

  const fallback = lastLines.slice(-8).join('\n').trim();
  return fallback || 'Build failed';
}

function getDashboardUrl(event: CloudflareEvent): string | null {
  const accountId = event.metadata?.accountId;
  const buildUuid = event.payload?.buildUuid;
  const workerName = event.source?.workerName || event.payload?.buildTriggerMetadata?.repoName || 'worker';
  
  if (!accountId || !buildUuid) return null;
  
  return `https://dash.cloudflare.com/${accountId}/workers/services/view/${workerName}/production/builds/${buildUuid}`;
}

function buildSlackBlocks(
  event: CloudflareEvent,
  previewUrl: string | null,
  liveUrl: string | null,
  logs: string[]
) {
  const workerName = event.source?.workerName || 'Worker';
  const buildOutcome = event.payload?.buildOutcome;
  const meta = event.payload?.buildTriggerMetadata;
  const dashUrl = getDashboardUrl(event);
  const duration = getBuildDuration(event);
  const commitUrl = getCommitUrl(event);

  const isCancelled = buildOutcome === 'cancelled';
  const isFailed = event.type?.includes('failed') && !isCancelled;
  const isSucceeded = event.type?.includes('succeeded');
  const isProduction = isProductionBranch(meta?.branch);

  // Build context line: `branch` • commit • ⏱ duration
  const contextParts: string[] = [];
  if (meta?.branch) {
    contextParts.push(`\`${meta.branch}\``);
  }
  if (meta?.commitHash) {
    const commitText = meta.commitHash.substring(0, 7);
    contextParts.push(commitUrl ? `<${commitUrl}|${commitText}>` : commitText);
  }
  if (duration) {
    contextParts.push(`⏱ ${duration}`);
  }
  const contextLine = contextParts.length > 0 ? contextParts.join('  •  ') : '';

  // ===================
  // SUCCESS: Production
  // ===================
  if (isSucceeded && isProduction) {
    const commitMsg = truncateCommitMessage(meta?.commitMessage);
    
    let text = `✅ *${workerName}* deployed to production`;
    if (commitMsg) text += `\n${commitMsg}`;
    if (contextLine) text += `\n${contextLine}`;

    const buttons: any[] = [];
    if (liveUrl) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'Open Worker', emoji: true },
        url: liveUrl,
        style: 'primary',
      });
    }
    if (dashUrl) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Build', emoji: true },
        url: dashUrl,
      });
    }

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ];
    if (buttons.length > 0) {
      blocks.push({ type: 'actions', elements: buttons });
    }

    return { blocks };
  }

  // =================
  // SUCCESS: Preview
  // =================
  if (isSucceeded && !isProduction) {
    const commitMsg = truncateCommitMessage(meta?.commitMessage);
    
    let text = `✅ *${workerName}* preview ready`;
    if (commitMsg) text += `\n${commitMsg}`;
    if (contextLine) text += `\n${contextLine}`;

    const buttons: any[] = [];
    if (previewUrl) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Preview', emoji: true },
        url: previewUrl,
        style: 'primary',
      });
    }
    if (dashUrl) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: 'View Build', emoji: true },
        url: dashUrl,
      });
    }

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ];
    if (buttons.length > 0) {
      blocks.push({ type: 'actions', elements: buttons });
    }

    return { blocks };
  }

  // =================
  // SUCCESS: No URL (fallback)
  // =================
  if (isSucceeded) {
    const commitMsg = truncateCommitMessage(meta?.commitMessage);
    
    let text = `✅ *${workerName}* deployed`;
    if (commitMsg) text += `\n${commitMsg}`;
    if (contextLine) text += `\n${contextLine}`;

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ];
    if (dashUrl) {
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'View Build', emoji: true },
          url: dashUrl,
        }],
      });
    }

    return { blocks };
  }

  // =========
  // FAILED
  // =========
  if (isFailed) {
    const error = extractBuildError(logs);

    let text = `❌ *${workerName}* build failed`;

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ];

    // Metadata fields
    if (meta) {
      const fields: any[] = [];
      if (meta.branch) fields.push({ type: 'mrkdwn', text: `*Branch*\n\`${meta.branch}\`` });
      if (meta.commitHash) {
        const commitText = meta.commitHash.substring(0, 7);
        fields.push({ 
          type: 'mrkdwn', 
          text: `*Commit*\n${commitUrl ? `<${commitUrl}|${commitText}>` : commitText}` 
        });
      }
      if (meta.author) fields.push({ type: 'mrkdwn', text: `*Author*\n${meta.author.split('@')[0]}` });
      if (duration) fields.push({ type: 'mrkdwn', text: `*Duration*\n${duration}` });
      
      if (fields.length > 0) {
        blocks.push({ type: 'section', fields });
      }
    }

    // Error block
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `\`\`\`${error}\`\`\`` },
    });

    if (dashUrl) {
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'View Full Logs', emoji: true },
          url: dashUrl,
          style: 'danger',
        }],
      });
    }

    return { blocks };
  }

  // ===========
  // CANCELLED
  // ===========
  if (isCancelled) {
    let text = `⚠️ *${workerName}* build cancelled`;
    if (contextLine) text += `\n${contextLine}`;

    const blocks: any[] = [
      { type: 'section', text: { type: 'mrkdwn', text } },
    ];

    if (dashUrl) {
      blocks.push({
        type: 'actions',
        elements: [{
          type: 'button',
          text: { type: 'plain_text', text: 'View Build', emoji: true },
          url: dashUrl,
        }],
      });
    }

    return { blocks };
  }

  // =========
  // FALLBACK
  // =========
  return {
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: `📢 ${event.type || 'Unknown event'}` },
    }],
  };
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default {
  async queue(batch: MessageBatch<CloudflareEvent>, env: Env): Promise<void> {
    if (!env.SLACK_WEBHOOK_URL) {
      console.error('SLACK_WEBHOOK_URL is not configured');
      for (const message of batch.messages) {
        message.ack();
      }
      return;
    }

    for (const message of batch.messages) {
      try {
        const event = message.body;

        if (!event?.type || !event?.payload || !event?.metadata) {
          console.error('Invalid event structure:', JSON.stringify(event));
          message.ack();
          continue;
        }

        if (event.type.includes('started') || event.type.includes('queued')) {
          message.ack();
          continue;
        }

        const isSucceeded = event.type.includes('succeeded');
        const isFailed = event.type.includes('failed');
        const buildOutcome = event.payload.buildOutcome;
        const isCancelled = buildOutcome === 'cancelled';
        const workerName = event.source?.workerName || event.payload.buildTriggerMetadata?.repoName;
        const accountId = event.metadata.accountId;

        let previewUrl: string | null = null;
        let liveUrl: string | null = null;

        if (isSucceeded && workerName && accountId && env.CLOUDFLARE_API_TOKEN) {
          try {
            const buildRes = await fetch(
              `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/builds/${event.payload.buildUuid}`,
              { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
            );
            const buildData: any = await buildRes.json();

            if (buildData.result?.preview_url) {
              previewUrl = buildData.result.preview_url;
            } else {
              const subRes = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
                { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
              );
              const subData: any = await subRes.json();
              if (subData.result?.subdomain) {
                liveUrl = `https://${workerName}.${subData.result.subdomain}.workers.dev`;
              }
            }
          } catch (error) {
            console.error('Failed to fetch URLs:', error);
          }
        }

        let logs: string[] = [];

        if (isFailed && !isCancelled && accountId && env.CLOUDFLARE_API_TOKEN) {
          try {
            let cursor: string | null = null;

            do {
              const logsEndpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/builds/${event.payload.buildUuid}/logs${cursor ? `?cursor=${cursor}` : ''}`;

              const logsRes = await fetch(logsEndpoint, {
                headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
              });
              const logsData: any = await logsRes.json();

              if (logsData.result?.lines?.length > 0) {
                const lines = logsData.result.lines.map((l: [number, string]) => l[1]);
                logs = logs.concat(lines);
              }

              cursor = logsData.result?.truncated ? logsData.result?.cursor : null;
            } while (cursor);
          } catch (error) {
            console.error('Failed to fetch logs:', error);
          }
        }

        const slackPayload = buildSlackBlocks(event, previewUrl, liveUrl, logs);

        const response = await fetch(env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slackPayload),
        });

        if (!response.ok) {
          console.error('Slack API error:', response.status, await response.text());
        }

        message.ack();
      } catch (error) {
        console.error('Error processing message:', error);
        message.ack();
      }
    }
  },
};
