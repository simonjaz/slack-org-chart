// Finds the custom profile fields the chart needs. Slack's own Manager field
// is a "user" type field; companies that built their own usually label it
// "Manager" or "Reports to".
export interface ProfileFieldDef {
  id: string;
  label?: string;
  type?: string;
  is_hidden?: boolean;
}

const MANAGER_LABELS = [/^manager$/i, /^reports? to$/i, /^line manager$/i, /manager/i];
const DEPARTMENT_LABELS = [/^department$/i, /^team$/i, /^division$/i, /department/i];

export function findManagerField(fields: ProfileFieldDef[]): string | undefined {
  const shown = fields.filter((f) => !f.is_hidden);
  return (
    pickByLabel(
      shown.filter((f) => f.type === 'user'),
      MANAGER_LABELS,
    ) ?? pickByLabel(shown, MANAGER_LABELS.slice(0, 3))
  );
}

export function findDepartmentField(fields: ProfileFieldDef[]): string | undefined {
  return pickByLabel(
    fields.filter((f) => f.type !== 'user' && f.type !== 'link' && !f.is_hidden),
    DEPARTMENT_LABELS,
  );
}

function pickByLabel(fields: ProfileFieldDef[], patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = fields.find((f) => f.label && pattern.test(f.label.trim()));
    if (match) return match.id;
  }
  return undefined;
}

// A user field can hold several ids separated by commas. The chart is a tree,
// so the first one is the manager.
export function readManagerId(value: string | undefined | null): string | null {
  if (!value) return null;
  const first = value.split(',')[0]?.trim();
  return first && /^[UW][A-Z0-9]+$/.test(first) ? first : null;
}
