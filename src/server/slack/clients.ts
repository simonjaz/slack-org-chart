import type { InstallationStore } from '@slack/bolt';
import { WebClient } from '@slack/web-api';

// Team ids start with T, Enterprise Grid org ids with E.
export async function botClientFor(store: InstallationStore, tenant: string): Promise<WebClient> {
  const enterprise = tenant.startsWith('E');
  const installation = await store.fetchInstallation({
    teamId: enterprise ? undefined : tenant,
    enterpriseId: enterprise ? tenant : undefined,
    isEnterpriseInstall: enterprise,
  });
  const token = installation.bot?.token;
  if (!token) throw new Error(`No bot token for ${tenant}`);
  // WebClient waits and retries when Slack answers 429.
  return new WebClient(token, { retryConfig: { retries: 10 } });
}
