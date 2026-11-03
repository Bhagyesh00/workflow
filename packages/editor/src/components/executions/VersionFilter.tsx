/**
 * Executions list filter by workflow version (P3-10, as n8n's workflowVersionId filter); shown when
 * one workflow is selected. The page keeps it in the URL param workflowVersionId ('' = any version).
 */
import { formatDateTime } from '../../lib/format';
import { Select } from '../ui/Field';
import { useWorkflowVersions } from './VersionLabel';

export function VersionFilter({
  workflowId,
  value,
  onChange,
}: {
  workflowId: string;
  value: string;
  onChange: (workflowVersionId: string) => void;
}) {
  const versions = useWorkflowVersions(workflowId);
  const list = versions.data ?? [];
  // a version from the URL that is not among the newest ones still shows as selected
  const missing = value && !list.some((v) => v.versionId === value);
  return (
    <Select
      aria-label="Filter by version"
      className="w-56"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">All versions</option>
      {missing && <option value={value}>{value.slice(0, 8)}</option>}
      {list.map((v) => (
        <option key={v.versionId} value={v.versionId}>
          {v.versionName ?? `${v.versionId.slice(0, 8)} (${formatDateTime(v.createdAt)})`}
        </option>
      ))}
    </Select>
  );
}
