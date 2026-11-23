const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {fileEntry, filePreview, localPath, imageTypes, readPreviewImage} = require('../src/clipboard-files');

async function main() {
  assert.ok(localPath('C:/资料夹/图 像.JPG', 'win32'));
  for (const file of ['//server/share/a.png', '//?/C:/a.png', '//./pipe/a.png', 'C:a.png',
    '/a.png', 'file:///C:/a.png', 'C:/a.png:other.png', 'C:/NUL.jpg', 'C:/../a.png', 'C:/a./b.png']) {
    assert.equal(localPath(file, 'win32'), false, file);
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openall-clip-image-'));
  const inspect = async file => (await fs.lstat(file)).isFile() ? 'file' : 'folder';
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ1sAAAAASUVORK5CYII=', 'base64');
    const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    const raster = {width:3, height:2, depth:8, data:new Uint8ClampedArray(24).fill(220)};
    const codecs = await import('icodec/node');
    for (const [extension, kind] of [['.JPG','jpeg'], ['.webp','webp'], ['.png','png'], ['.GIF','gif']]) {
      let bytes = kind === 'png' ? png : kind === 'gif' ? gif : null;
      if (!bytes) {
        await codecs[kind].loadEncoder();
        bytes = Buffer.from(codecs[kind].encode(raster));
      }
      const file = path.join(root, '图 #1' + extension);
      await fs.writeFile(file, bytes);
      const entry = fileEntry([file]);
      assert.equal(entry.kind, 'files');
      assert.deepEqual(entry.files, [file]);
      const preview = await filePreview(file, undefined, inspect);
      assert.equal(preview.kind, 'file');
      assert.equal(preview.mime, imageTypes[extension.toLowerCase()]);
      assert.deepEqual((await readPreviewImage(file, preview.mime)).bytes, bytes);
    }
    const file = path.join(root, '损坏.png');
    await fs.writeFile(file, gif);
    assert.equal(await readPreviewImage(file, 'image/png'), null);
    const huge = Buffer.from(png);
    huge.writeUInt32BE(5000, 16);
    huge.writeUInt32BE(5000, 20);
    await fs.writeFile(file, huge);
    assert.equal(await readPreviewImage(file, 'image/png'), null);
    await fs.truncate(file, 24 * 1024 * 1024 + 1);
    assert.equal(await readPreviewImage(file, 'image/png'), null);
    await fs.unlink(file);
    assert.equal(await readPreviewImage(file, 'image/png'), null);
    const network = await filePreview('//server/share/a.png', undefined, () => {throw Error('不应访问网络路径');});
    assert.equal(network.systemIcon, false);
    assert.equal(network.mime, undefined);
    if (process.platform !== 'win32') {
      const link = path.join(root, '链接目录');
      await fs.symlink(root, link);
      assert.equal((await filePreview(path.join(link, '图 #1.png'))).mime, undefined);
    }
  } finally {
    await fs.rm(root, {recursive:true, force:true});
  }
  console.log('文件图片预览通过格式识别、文件语义、尺寸上限、路径与缺失文件回归');
}
main().catch(error => {console.error(error); process.exitCode = 1;});
