export type StepKey = 'design' | 'configure' | 'participants' | 'generate';

export interface StepDef {
  key: StepKey;
  label: string;
  helper: string;
}

export const STEPS: StepDef[] = [
  { key: 'design', label: 'Design', helper: 'Lay out fields on the PDF' },
  { key: 'configure', label: 'Configure data', helper: 'Map fields to Excel columns' },
  { key: 'participants', label: 'Upload participants', helper: 'Validate the spreadsheet' },
  { key: 'generate', label: 'Generate & download', helper: 'Create certificates' },
];
