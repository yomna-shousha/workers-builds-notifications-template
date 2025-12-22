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

function extractBuildError(logs: string[]): string {
  if (!logs || logs.length === 0) {
    return 'No logs available';
  }

  // Look for the actual error message (not stack traces)
  // Error messages usually start with "Error:" or similar
  for (let i = 0; i < logs.length; i++) {
    const line = logs[i];
    // Skip stack trace lines
    if (line?.trim().startsWith('at ')) continue;
    
    // Look for error message patterns
    if (line?.match(/^Error:|^ERROR:|^\[ERROR\]|^✘.*ERROR/i)) {
      // Get this line and maybe the next line if it's not a stack trace
      let errorMsg = line;
      if (logs[i + 1] && !logs[i + 1]?.trim().startsWith('at ')) {
        errorMsg += '\n' + logs[i + 1];
      }
      return errorMsg.length > 500 ? errorMsg.substring(0, 500) + '...' : errorMsg;
    }
  }

  // Fallback: look for common error indicators in last 20 lines
  const lastLines = logs.slice(-20);
  const errorIndicators = [
    'Failed:', 'failed:', 'FAILED:',
    'Module not found', 'Cannot find module',
    'Build failed', 'Compilation failed',
    'SyntaxError', 'TypeError', 'ReferenceError',
  ];

  for (const line of lastLines) {
    if (errorIndicators.some((indicator) => line?.includes(indicator))) {
      return line.length > 500 ? line.substring(0, 500) + '...' : line;
    }
  }

  // Last resort: return last non-empty line
  for (let i = logs.length - 1; i >= 0; i--) {
    if (logs[i]?.trim()) {
      const line = logs[i];
      return line.length > 500 ? line.substring(0, 500) + '...' : line;
    }
  }

  return 'Build failed';
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
  const commitUrl = getCommitUrl(event);

  const isCancelled = buildOutcome === 'cancelled';
  const isFailed = event.type?.includes('failed') && !isCancelled;
  const isSucceeded = event.type?.includes('succeeded');
  const isProduction = isProductionBranch(meta?.branch);

  // Build context line: `branch` • commit
  const contextParts: string[] = [];
  if (meta?.branch) {
    contextParts.push(`\`${meta.branch}\``);
  }
  if (meta?.commitHash) {
    const commitText = meta.commitHash.substring(0, 7);
    contextParts.push(commitUrl ? `<${commitUrl}|${commitText}>` : commitText);
  }
  const contextLine = contextParts.length > 0 ? contextParts.join('  •  ') : '';

  // ===================
  // SUCCESS: Production
  // ===================
  if (isSucceeded && isProduction) {
    let text = `✅ *${workerName}* deployed successfully`;
    if (contextLine) text += `\n${contextLine}`;

    const block: any = {
      type: 'section',
      text: { type: 'mrkdwn', text },
    };

    if (liveUrl) {
      block.accessory = {
        type: 'button',
        text: { type: 'plain_text', text: 'View Worker', emoji: true },
        url: liveUrl,
      };
    }

    return { blocks: [block] };
  }

  // =================
  // SUCCESS: Preview
  // =================
  if (isSucceeded && !isProduction) {
    let text = `✅ *${workerName}* preview ready`;
    if (contextLine) text += `\n${contextLine}`;

    const block: any = {
      type: 'section',
      text: { type: 'mrkdwn', text },
    };

    if (previewUrl) {
      block.accessory = {
        type: 'button',
        text: { type: 'plain_text', text: 'View Preview', emoji: true },
        url: previewUrl,
      };
    }

    return { blocks: [block] };
  }

  // =================
  // SUCCESS: No URL (fallback)
  // =================
  if (isSucceeded) {
    let text = `✅ *${workerName}* deployed successfully`;
    if (contextLine) text += `\n${contextLine}`;

    const block: any = {
      type: 'section',
      text: { type: 'mrkdwn', text },
    };

    if (dashUrl) {
      block.accessory = {
        type: 'button',
        text: { type: 'plain_text', text: 'View Build', emoji: true },
        url: dashUrl,
      };
    }

    return { blocks: [block] };
  }

  // =========
  // FAILED
  // =========
  if (isFailed) {
    const error = extractBuildError(logs);

    const blocks: any[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: `❌ Build Failed: ${workerName}`, emoji: true },
      },
    ];

    // Metadata fields
    const fields: any[] = [];
    if (meta?.branch) fields.push({ type: 'mrkdwn', text: `*Branch*\n\`${meta.branch}\`` });
    if (meta?.commitHash) {
      const commitText = meta.commitHash.substring(0, 7);
      fields.push({ 
        type: 'mrkdwn', 
        text: `*Commit*\n${commitUrl ? `<${commitUrl}|${commitText}>` : commitText}` 
      });
    }
    if (meta?.author) {
      const authorName = meta.author.includes('@') ? meta.author.split('@')[0] : meta.author;
      fields.push({ type: 'mrkdwn', text: `*Author*\n${authorName}` });
    }
    
    if (fields.length > 0) {
      blocks.push({ type: 'section', fields });
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

    const block: any = {
      type: 'section',
      text: { type: 'mrkdwn', text },
    };

    if (dashUrl) {
      block.accessory = {
        type: 'button',
        text: { type: 'plain_text', text: 'View Build', emoji: true },
        url: dashUrl,
      };
    }

    return { blocks: [block] };
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
