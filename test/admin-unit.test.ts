import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/server/admin/csv.js';
import { createsLoop } from '../src/server/admin/service.js';
import { canBeAdmin } from '../src/server/admin/access.js';

describe('parseCsv', () => {
  it('reads quoted cells, escaped quotes, CRLF and skips blank lines', () => {
    const rows = parseCsv('﻿email,manager_email,title\r\na@x.com,b@x.com,"Lead, ""Platform"""\r\n\r\nc@x.com,,\n');
    expect(rows).toEqual([
      { line: 1, cells: ['email', 'manager_email', 'title'] },
      { line: 2, cells: ['a@x.com', 'b@x.com', 'Lead, "Platform"'] },
      { line: 4, cells: ['c@x.com', '', ''] },
    ]);
  });

  it('keeps line numbers right after a quoted line break', () => {
    const rows = parseCsv('email,title\na@x.com,"two\nlines"\nb@x.com,x');
    expect(rows.map((r) => r.line)).toEqual([1, 2, 4]);
    expect(rows[1]!.cells[1]).toBe('two\nlines');
  });
});

describe('createsLoop', () => {
  const map = (pairs: [string, string | null][]) => new Map(pairs);

  it('finds direct and longer loops', () => {
    expect(createsLoop(map([['A', 'B'], ['B', 'A']]), 'A')).toBe(true);
    expect(createsLoop(map([['A', 'B'], ['B', 'C'], ['C', 'A']]), 'A')).toBe(true);
  });

  it('accepts chains and ignores loops elsewhere', () => {
    expect(createsLoop(map([['A', 'B'], ['B', 'C'], ['C', null]]), 'A')).toBe(false);
    expect(createsLoop(map([['A', 'B'], ['B', 'C'], ['C', 'B']]), 'A')).toBe(false);
  });
});

describe('canBeAdmin', () => {
  it('allows active employees only', () => {
    expect(canBeAdmin({ userType: 'employee', isDeleted: false })).toBe(true);
    expect(canBeAdmin({ userType: 'employee', isDeleted: true })).toBe(false);
    expect(canBeAdmin({ userType: 'multi_channel_guest', isDeleted: false })).toBe(false);
    expect(canBeAdmin({ userType: 'slack_connect', isDeleted: false })).toBe(false);
    expect(canBeAdmin({ userType: 'bot', isDeleted: false })).toBe(false);
  });

  it('respects an admin marking someone external, but never promotes a guest', () => {
    expect(canBeAdmin({ userType: 'employee', isDeleted: false, override: { userType: 'contractor' } })).toBe(false);
    expect(canBeAdmin({ userType: 'single_channel_guest', isDeleted: false, override: { userType: 'employee' } })).toBe(
      false,
    );
  });
});
