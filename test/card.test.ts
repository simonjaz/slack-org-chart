import { describe, expect, it } from 'vitest';
import { cardHtml, escapeHtml, initials } from '../web/src/card.js';

describe('card', () => {
  it('escapes names and titles typed into Slack', () => {
    const html = cardHtml(
      {
        id: 'U1',
        parentId: null,
        kind: 'person',
        name: '<img src=x onerror=alert(1)>',
        title: '"><script>alert(1)</script>',
        avatarUrl: 'https://avatars.slack-edge.com/a.png" onload="alert(1)',
        descendants: 0,
      },
      { isViewer: false, isFocus: false },
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('" onload="');
  });

  it('marks external people with a badge word and their company', () => {
    const html = cardHtml(
      { id: 'U1', parentId: null, kind: 'person', name: 'Ann', badge: 'external', externalOrg: 'Globex', descendants: 0 },
      { isViewer: false, isFocus: false },
    );
    expect(html).toContain('card-outside');
    expect(html).toContain('External · Globex');
  });

  it('marks the viewer', () => {
    const html = cardHtml(
      { id: 'U1', parentId: null, kind: 'person', name: 'Ann', descendants: 0 },
      { isViewer: true, isFocus: true },
    );
    expect(html).toContain('card-viewer');
    expect(html).toContain('>You<');
  });

  it('builds initials for the photo fallback', () => {
    expect(initials('Ada Lovelace')).toBe('AL');
    expect(initials('Cher')).toBe('C');
    expect(initials('  ')).toBe('?');
    expect(escapeHtml(`a&b<'"`)).toBe('a&#38;b&#60;&#39;&#34;');
  });
});
