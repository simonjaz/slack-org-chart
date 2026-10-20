import { describe, expect, it } from 'vitest';
import { findDepartmentField, findManagerField, readManagerId } from '../src/server/slack/profileFields.js';

describe('profile fields', () => {
  it("finds Slack's user-type Manager field", () => {
    const fields = [
      { id: 'Xf1', label: 'Pronouns', type: 'text' },
      { id: 'Xf2', label: 'Manager', type: 'user' },
    ];
    expect(findManagerField(fields)).toBe('Xf2');
  });

  it('prefers a user-type field over a text field with the same label', () => {
    const fields = [
      { id: 'Xf1', label: 'Manager', type: 'text' },
      { id: 'Xf2', label: 'Reports to', type: 'user' },
    ];
    expect(findManagerField(fields)).toBe('Xf2');
  });

  it('skips hidden fields and returns undefined when nothing matches', () => {
    expect(findManagerField([{ id: 'Xf1', label: 'Manager', type: 'user', is_hidden: true }])).toBeUndefined();
    expect(findManagerField([{ id: 'Xf1', label: 'Favourite food', type: 'text' }])).toBeUndefined();
  });

  it('finds a department field', () => {
    expect(
      findDepartmentField([
        { id: 'Xf1', label: 'Manager', type: 'user' },
        { id: 'Xf3', label: 'Department', type: 'options_list' },
      ]),
    ).toBe('Xf3');
  });

  it('reads the first valid user id from a field value', () => {
    expect(readManagerId('U123')).toBe('U123');
    expect(readManagerId('U123,U456')).toBe('U123');
    expect(readManagerId('W999')).toBe('W999');
    expect(readManagerId('Jane Smith')).toBeNull();
    expect(readManagerId('')).toBeNull();
    expect(readManagerId(undefined)).toBeNull();
  });
});
