// Swapped in for web/src/actions.ts when the demo is built (see
// vite.config.ts). Slack's own links (slack://...) would leave the page, so
// they become #oc- links the mock Slack around the chart picks up.
export * from '../web/src/actions';

export const dmLink = (_teamId: string, userId: string) => `#oc-dm-${encodeURIComponent(userId)}`;
export const channelLink = (_teamId: string, channelId: string) => `#oc-open-${encodeURIComponent(channelId)}`;
export const webChannelLink = channelLink;
