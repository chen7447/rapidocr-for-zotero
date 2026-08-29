const { PDFDocument } = require('pdf-lib');
const fs = require('fs');
const [,, path] = process.argv;
(async () => {
  const d = await PDFDocument.load(fs.readFileSync(path), { ignoreEncryption: true });
  console.log('pages:', d.getPageCount());
  const pg = d.getPage(0);
  console.log('MediaBox:', JSON.stringify(pg.getMediaBox()));
  try { console.log('CropBox:', JSON.stringify(pg.getCropBox())); } catch (e) {}
  console.log('Rotate:', pg.getRotation().angle);
})().catch(e => console.error('ERR', e.message));