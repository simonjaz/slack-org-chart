import { describe, expect, it } from 'vitest';
import { classifyUser, isExternal } from '../src/server/slack/classify.js';

const ws = { teamId: 'T1' };

describe('classifyUser', () => {
  it('treats full members of the workspace as employees', () => {
    expect(classifyUser({ id: 'U1', team_id: 'T1' }, ws)).toBe('employee');
  });

  it('flags multi and single channel guests', () => {
    expect(classifyUser({ id: 'U1', team_id: 'T1', is_restricted: true }, ws)).toBe('multi_channel_guest');
    expect(
      classifyUser({ id: 'U1', team_id: 'T1', is_restricted: true, is_ultra_restricted: true }, ws),
    ).toBe('single_channel_guest');
  });

  it('flags people from another team as Slack Connect', () => {
    expect(classifyUser({ id: 'U9', team_id: 'T9' }, ws)).toBe('slack_connect');
  });

  it('treats a sibling workspace in the same Enterprise Grid as internal', () => {
    const grid = { teamId: 'E1', enterpriseId: 'E1' };
    expect(classifyUser({ id: 'W1', team_id: 'T5', enterprise_user: { enterprise_id: 'E1' } }, grid)).toBe('employee');
    expect(classifyUser({ id: 'W2', team_id: 'T6', enterprise_user: { enterprise_id: 'E2' } }, grid)).toBe(
      'slack_connect',
    );
  });

  it('marks bots, app users and Slackbot as bots', () => {
    expect(classifyUser({ id: 'B1', team_id: 'T1', is_bot: true }, ws)).toBe('bot');
    expect(classifyUser({ id: 'U2', team_id: 'T1', is_app_user: true }, ws)).toBe('bot');
    expect(classifyUser({ id: 'USLACKBOT', team_id: 'T1' }, ws)).toBe('bot');
  });

  it('knows which types are external', () => {
    expect(isExternal('employee')).toBe(false);
    expect(isExternal('slack_connect')).toBe(true);
    expect(isExternal('single_channel_guest')).toBe(true);
    expect(isExternal('contractor')).toBe(true);
  });
});
