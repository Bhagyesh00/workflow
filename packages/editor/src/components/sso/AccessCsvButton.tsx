/**
 * P6-11: "Download current access" (CSV). Built in the browser from the member list and the project members, so the
 * admin keeps a copy of who holds which role before roles start to come from the identity provider. A cell that
 * starts with `=`, `+`, `-` or `@` (or a tab or return) is quoted with a leading apostrophe, so a spreadsheet never
 * runs a name as a formula.
 */
import { Download } from 'lucide-react';
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { membersApi, projectsApi } from '../../api/endpoints';
import { Button } from '../ui/Button';

/** one CSV cell: formula starters are neutralized, then quoted when it holds a comma, quote or line break */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export const ACCESS_CSV_HEADER = ['Email', 'Name', 'Workspace role', 'Project', 'Project role'];

/** the access rows: one per member, then one per project membership */
export async function loadAccessRows(): Promise<string[][]> {
  const members = await membersApi.list();
  const projects = (await projectsApi.list()).filter((p) => p.type === 'team');
  const details = await Promise.all(projects.map((p) => projectsApi.get(p.id)));
  const rows: string[][] = [ACCESS_CSV_HEADER];
  for (const member of members) {
    if (member.status === 'pending') continue;
    rows.push([member.email, member.name, String(member.role), '', '']);
  }
  const roleOf = new Map(members.map((m) => [m.email, String(m.role)]));
  for (const project of details) {
    for (const relation of project.relations) {
      rows.push([relation.email, relation.name, roleOf.get(relation.email) ?? '', project.name, relation.role]);
    }
  }
  return rows;
}

export function AccessCsvButton({ onError }: { onError?: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const csv = toCsv(await loadAccessRows());
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'current-access.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      onError?.(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button variant="secondary" size="sm" icon={<Download size={13} />} loading={busy} onClick={() => void download()}>
      Download current access (CSV)
    </Button>
  );
}
