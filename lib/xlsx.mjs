// Export the library to an .xlsx you can edit in Excel, and read one back.
// Only a handful of columns round-trip: Title, Designer, Tags, and Delete.
// Everything else (Folder, Size, the Open links) is there for reference and
// is ignored on import - editing it does nothing.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ExcelJS from 'exceljs';

const SHEET = 'Files';
const LINK_COLOR = { argb: 'FF1155CC' };

const COLS = [
  { key: 'id',       header: 'ID',          width: 8  },
  { key: 'delete',   header: 'Delete',      width: 9  },
  { key: 'title',    header: 'Title',       width: 34 },
  { key: 'designer', header: 'Designer',    width: 22 },
  { key: 'tags',     header: 'Tags',        width: 28 },
  { key: 'name',     header: 'File name',   width: 34 },
  { key: 'openFile', header: 'Open file',   width: 11 },
  { key: 'openFldr', header: 'Open folder', width: 13 },
  { key: 'folder',   header: 'Folder',      width: 42 },
  { key: 'size',     header: 'Size (MB)',   width: 11 },
  { key: 'ext',      header: 'Type',        width: 7  },
  { key: 'path',     header: 'Full path',   width: 50 },
];

// Windows path -> file:// URI. Excel opens these with whatever the OS has
// associated with the file, or Explorer for a folder.
// Uses Node's pathToFileURL rather than hand-encoding each segment: the old
// encodeURIComponent version turned the drive colon into "X%3A", and Excel
// rejects that as an invalid URI - every export needed "repair" and came
// back with all links stripped. pathToFileURL keeps "X:" literal and
// percent-encodes only what a URI actually requires.
function fileUrl(p) {
  return pathToFileURL(p).href;
}

export async function exportWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '3MF Explorer';
  wb.created = new Date();
  const ws = wb.addWorksheet(SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLS.map(c => ({ header: c.header, key: c.key, width: c.width }));
  ws.getRow(1).font = { bold: true };

  for (const r of rows) {
    const dir = path.dirname(r.path);
    const row = ws.addRow({
      id: r.id,
      delete: false,
      title: r.title || '',
      designer: r.designer || '',
      tags: (r.tags || []).join(', '),
      name: r.name,
      folder: r.rel ? path.dirname(r.rel).replace(/^\.$/, '') : (r.folder || ''),
      size: r.size ? +(r.size / 1e6).toFixed(2) : 0,
      ext: r.ext || '',
      path: r.path,
    });
    const openFile = row.getCell('openFile');
    openFile.value = { text: 'Open', hyperlink: fileUrl(r.path), tooltip: r.path };
    openFile.font = { color: LINK_COLOR, underline: true };
    const openFldr = row.getCell('openFldr');
    openFldr.value = { text: 'Folder', hyperlink: fileUrl(dir), tooltip: dir };
    openFldr.font = { color: LINK_COLOR, underline: true };
  }

  if (rows.length) {
    ws.dataValidations.add(`B2:B${rows.length + 1}`, {
      type: 'list', allowBlank: true, formulae: ['"TRUE,FALSE"'],
    });
  }
  return wb;
}

// Read an edited workbook back. Matches columns by their header text (not
// position) so re-sorting or re-widening columns in Excel doesn't break it -
// but the header row itself has to stay intact.
export async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.getWorksheet(SHEET) || wb.worksheets[0];
  if (!ws) throw new Error('no worksheet found in that file');

  const idx = {};
  ws.getRow(1).eachCell((cell, col) => {
    const h = String(cell.value ?? '').trim();
    if (h) idx[h] = col;
  });
  for (const need of ['ID', 'Delete', 'Title', 'Designer', 'Tags']) {
    if (!idx[need]) throw new Error(`missing "${need}" column - don't rename or remove header cells`);
  }

  const out = [];
  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const id = Number(row.getCell(idx.ID).value);
    if (!id) return;
    const delVal = row.getCell(idx.Delete).value;
    const del = delVal === true || /^\s*true\s*$/i.test(String(delVal ?? ''));
    out.push({
      id,
      del,
      title: String(row.getCell(idx.Title).value ?? '').trim(),
      designer: String(row.getCell(idx.Designer).value ?? '').trim(),
      tags: String(row.getCell(idx.Tags).value ?? '').trim(),
    });
  });
  return out;
}
