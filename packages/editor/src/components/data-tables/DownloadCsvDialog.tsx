/** Download a table as a CSV file, with or without the system columns (P4-05). */
import { useState } from 'react';
import { errorMessage } from '../../api/client';
import { dataTablesApi } from '../../api/endpoints';
import { safeFileName } from '../../lib/format';
import { toast } from '../../stores/ui-store';
import { Button } from '../ui/Button';
import { Dialog } from '../ui/Dialog';
import { Checkbox } from '../ui/Field';

function saveCsv(fileName: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DownloadCsvDialog({ tableId, onClose }: { tableId: string; onClose: () => void }) {
  const [includeSystem, setIncludeSystem] = useState(true);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    try {
      const { csvContent, dataTableName } = await dataTablesApi.downloadCsv(tableId, includeSystem);
      saveCsv(`${safeFileName(dataTableName)}.csv`, csvContent);
      onClose();
    } catch (cause) {
      toast.error('Error downloading CSV file', errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Download CSV"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void submit()}>
            Download
          </Button>
        </>
      }
    >
      <Checkbox
        label="Include system columns (id, createdAt, updatedAt)"
        checked={includeSystem}
        onChange={(event) => setIncludeSystem(event.target.checked)}
      />
    </Dialog>
  );
}
