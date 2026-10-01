import { describe, expect, it } from 'vitest';
import { officeFormat } from './contracts.js';

describe('officeFormat (round OFFICE)', () => {
  it('recognizes docx/xlsx/pptx by extension', () => {
    expect(officeFormat('notes/report.docx')).toBe('docx');
    expect(officeFormat('notes/Book1.xlsx')).toBe('xlsx');
    expect(officeFormat('slides/deck.pptx')).toBe('pptx');
  });

  it('is case-insensitive, same as every other extension check in this codebase', () => {
    expect(officeFormat('Report.DOCX')).toBe('docx');
    expect(officeFormat('Book1.XLSX')).toBe('xlsx');
  });

  it('returns undefined for anything else, including a bare filename with no directory', () => {
    expect(officeFormat('notes/plan.md')).toBeUndefined();
    expect(officeFormat('notes/report.pdf')).toBeUndefined();
    expect(officeFormat('deck.pptx.bak')).toBeUndefined();
    expect(officeFormat('report.docx')).toBe('docx');
  });
});
