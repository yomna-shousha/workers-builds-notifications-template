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
  /** Slack incoming webhook URL */
  SLACK_WEBHOOK_URL: string;
  /** Cloudflare API token with Workers Builds Configuration: Read permission */
  CLOUDFLARE_API_TOKEN: string;
}

// =============================================================================
// TYPE DEFINITIONS
// =============================================================================

/**
 * Cloudflare Workers Builds event structure
 * @see https://developers.cloudflare.com/workers/ci-cd/builds/events/
 */
interface CloudflareEvent {
  /** Event type (e.g., "cf.workersBuilds.worker.build.succeeded") */
  type: string;
  /** Event source information */
  source: {
    type: string;
    workerName?: string;
  };
  /** Build details */
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
  /** Event metadata */
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

/**
 * Calculate build duration from timestamps
 */
function getBuildDuration(event: CloudflareEvent): string | null {
  const start = event.payload.createdAt;
  const end = event.payload.stoppedAt;
  
  if (!start || !end) return null;
  
  const durationMs = new Date(end).getTime() - new Date(start).getTime();
  const seconds = Math.floor(durationMs / 1000);
  
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

/**
 * Get GitHub commit URL if available
 */
function getCommitUrl(event: CloudflareEvent): string | null {
  const meta = event.payload.buildTriggerMetadata;
  if (!meta?.repoName || !meta?.commitHash || !meta?.providerAccountName) return null;
  
  if (meta.providerType === 'github') {
    return `https://github.com/${meta.providerAccountName}/${meta.repoName}/commit/${meta.commitHash}`;
  }
  if (meta.providerType === 'gitlab') {
    return `https://gitlab.com/${meta.providerAccountName}/${meta.repoName}/-/commit/${meta.commitHash}`;
  }
  return null;
}

/**
 * Check if branch is production (main/master)
 */
function isProductionBranch(branch: string): boolean {
  return ['main', 'master', 'production', 'prod'].includes(branch.toLowerCase());
}

/**
 * Truncate commit message to first line, max 50 chars
 */
function truncateCommitMessage(message: string): string {
  const firstLine = message.split('\n')[0].trim();
  return firstLine.length > 50 ? firstLine.substring(0, 47) + '...' : firstLine;
}

/**
 * Extract the relevant error from build logs (last ~10 lines with error context)
 */
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
    if (errorIndicators.some((indicator) => lastLines[i].includes(indicator))) {
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

/**
 * Generate dashboard URL for build logs
 */
function getDashboardUrl(event: CloudflareEvent): string {
  const workerName = event.source.workerName || event.payload.buildTriggerMetadata?.repoName || 'worker';
  return `https://dash.cloudflare.com/${event.metadata.accountId}/workers/services/view/${workerName}/production/builds/${event.payload.buildUuid}`;
}

/**
 * Build Slack Block Kit message based on event type
 */
function buildSlackBlocks(
  event: CloudflareEvent,
  previewUrl: string | null,
  liveUrl: string | null,
  logs: string[]
) {
  const workerName = event.source.workerName || 'Worker';
  const buildOutcome = event.payload.buildOutcome;
  const meta = event.payload.buildTriggerMetadata;
  const dashUrl = getDashboardUrl(event);
  const duration = getBuildDuration(event);
  const commitUrl = getCommitUrl(event);

  const isCancelled = buildOutcome === 'cancelled';
  const isFailed = event.type.includes('failed') && !isCancelled;
  const isSucceeded = event.type.includes('succeeded');
  const isProduction = meta ? isProductionBranch(meta.branch) : true;

  // Build context elements (branch, commit, duration)
  const contextElements: any[] = [];
  
  if (meta?.branch) {
    contextElements.push({
      type: 'mrkdwn',
      text: `\`${meta.branch}\``,
    });
  }
  
  if (meta?.commitHash) {
    const commitText = meta.commitHash.substring(0, 7);
    contextElements.push({
      type: 'mrkdwn',
      text: commitUrl ? `<${commitUrl}|${commitText}>` : commitText,
    });
  }
  
  if (duration) {
    contextElements.push({
      type: 'mrkdwn',
      text: `⏱ ${duration}`,
    });
  }

  // ===================
  // SUCCESS: Production
  // ===================
  if (isSucceeded && isProduction) {
    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *${workerName}* deployed to production${meta?.commitMessage ? '\n' + truncateCommitMessage(meta.commitMessage) : ''}`,
        },
      },
    ];

    if (contextElements.length > 0) {
      blocks.push({ type: 'context', elements: contextElements });
    }

    const buttons: any[] = [];
    if (liveUrl) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: '🌐 Open Worker', emoji: true },
        url: liveUrl,
        style: 'primary',
      });
    }
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View Build', emoji: true },
      url: dashUrl,
    });

    blocks.push({ type: 'actions', elements: buttons });

    return {
      text: `✅ ${workerName} deployed to production`,
      attachments: [{
        color: '#22c55e',
        blocks,
      }],
    };
  }

  // =================
  // SUCCESS: Preview
  // =================
  if (isSucceeded && !isProduction) {
    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `🔮 *${workerName}* preview ready${meta?.commitMessage ? '\n' + truncateCommitMessage(meta.commitMessage) : ''}`,
        },
      },
    ];

    if (contextElements.length > 0) {
      blocks.push({ type: 'context', elements: contextElements });
    }

    const buttons: any[] = [];
    if (previewUrl) {
      buttons.push({
        type: 'button',
        text: { type: 'plain_text', text: '🔮 View Preview', emoji: true },
        url: previewUrl,
        style: 'primary',
      });
    }
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View Build', emoji: true },
      url: dashUrl,
    });

    blocks.push({ type: 'actions', elements: buttons });

    return {
      text: `🔮 ${workerName} preview ready`,
      attachments: [{
        color: '#8b5cf6',
        blocks,
      }],
    };
  }

  // =================
  // SUCCESS: No URL
  // =================
  if (isSucceeded) {
    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `✅ *${workerName}* deployed${meta?.commitMessage ? '\n' + truncateCommitMessage(meta.commitMessage) : ''}`,
        },
      },
    ];

    if (contextElements.length > 0) {
      blocks.push({ type: 'context', elements: contextElements });
    }

    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'View Build', emoji: true },
        url: dashUrl,
      }],
    });

    return {
      text: `✅ ${workerName} deployed`,
      attachments: [{
        color: '#22c55e',
        blocks,
      }],
    };
  }

  // =========
  // FAILED
  // =========
  if (isFailed) {
    const error = extractBuildError(logs);

    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `❌ *${workerName}* build failed`,
        },
      },
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
      text: {
        type: 'mrkdwn',
        text: `\`\`\`${error}\`\`\``,
      },
    });

    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '📋 View Full Logs', emoji: true },
        url: dashUrl,
        style: 'danger',
      }],
    });

    return {
      text: `❌ ${workerName} build failed`,
      attachments: [{
        color: '#ef4444',
        blocks,
      }],
    };
  }

  // ===========
  // CANCELLED
  // ===========
  if (isCancelled) {
    const blocks: any[] = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `⚠️ *${workerName}* build cancelled`,
        },
      },
    ];

    if (contextElements.length > 0) {
      blocks.push({ type: 'context', elements: contextElements });
    }

    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'View Build', emoji: true },
        url: dashUrl,
      }],
    });

    return {
      text: `⚠️ ${workerName} build cancelled`,
      attachments: [{
        color: '#f59e0b',
        blocks,
      }],
    };
  }

  // =========
  // FALLBACK
  // =========
  return {
    text: event.type,
    blocks: [{
      type: 'section',
      text: { type: 'mrkdwn', text: `📢 ${event.type}` },
    }],
  };
}

// =============================================================================
// MAIN HANDLER
// =============================================================================

export default {
  async queue(batch: MessageBatch<CloudflareEvent>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const event = message.body;

        // Skip started events completely
        const isStarted = event.type.includes('started') || event.type.includes('queued');
        if (isStarted) {
          message.ack();
          continue;
        }

        const isSucceeded = event.type.includes('succeeded');
        const isFailed = event.type.includes('failed');
        const buildOutcome = event.payload.buildOutcome;
        const isCancelled = buildOutcome === 'cancelled';
        const workerName = event.source.workerName || event.payload.buildTriggerMetadata?.repoName;

        // ---------------------------------------------------------------------
        // FETCH URLs FOR SUCCESSFUL BUILDS
        // ---------------------------------------------------------------------

        let previewUrl: string | null = null;
        let liveUrl: string | null = null;

        if (isSucceeded && workerName) {
          try {
            const buildRes = await fetch(
              `https://api.cloudflare.com/client/v4/accounts/${event.metadata.accountId}/builds/builds/${event.payload.buildUuid}`,
              { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } }
            );
            const buildData: any = await buildRes.json();

            if (buildData.result?.preview_url) {
              previewUrl = buildData.result.preview_url;
            } else {
              // Try to get live URL
              const subRes = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${event.metadata.accountId}/workers/subdomain`,
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

        // ---------------------------------------------------------------------
        // FETCH LOGS FOR FAILED BUILDS
        // ---------------------------------------------------------------------

        let logs: string[] = [];

        if (isFailed && !isCancelled) {
          try {
            let cursor: string | null = null;

            do {
              const logsEndpoint = cursor
                ? `https://api.cloudflare.com/client/v4/accounts/${event.metadata.accountId}/builds/builds/${event.payload.buildUuid}/logs?cursor=${cursor}`
                : `https://api.cloudflare.com/client/v4/accounts/${event.metadata.accountId}/builds/builds/${event.payload.buildUuid}/logs`;

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

        // ---------------------------------------------------------------------
        // BUILD AND SEND SLACK MESSAGE
        // ---------------------------------------------------------------------

        const slackPayload = buildSlackBlocks(event, previewUrl, liveUrl, logs);

        await fetch(env.SLACK_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(slackPayload),
        });

        message.ack();
      } catch (error) {
        console.error('Error processing message:', error);
        message.ack();
      }
    }
  },
};
