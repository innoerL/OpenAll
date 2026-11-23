const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

const previewLimit = 3;
const appExtensions = new Set(['.exe', '.msi', '.msix', '.app', '.lnk']);
const archiveExtensions = new Set(['.zip', '.7z', '.rar', '.gz', '.tgz', '.bz2', '.xz', '.tar', '.zst', '.cab', '.dmg', '.pkg']);
const imageTypes = {'.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.jfif':'image/jpeg',
  '.webp':'image/webp', '.gif':'image/gif', '.bmp':'image/bmp'};
const maxImageBytes = 24 * 1024 * 1024;

function localPath(file, platform = process.platform) {
  if (typeof file !== 'string' || /[\x00-\x1f]/.test(file) || /^[\\/]{2}/.test(file)) return false;
  if (platform !== 'win32') return path.posix.isAbsolute(file) && !file.split('/').includes('..');
  // 只接受明确的盘符路径。设备名、备用数据流和可被 Win32 折叠的路径段均不访问。
  if (!/^[a-z]:[\\/]/i.test(file)) return false;
  return file.slice(3).split(/[\\/]/).every(part => !/[<>:"|?*]|[ .]$/.test(part)
    && !/^(?:con|nul|aux|prn|conin\$|conout\$|(?:lpt|com)[1-9¹²³])(?:\.|$)/i.test(part));
}

async function inspectPosixFile(file) {
  // macOS 的临时目录通常经由系统的 /var 或 /tmp 别名。
  const absolute = process.platform === 'darwin' ? file.replace(/^\/(var|tmp)(?=\/|$)/, '/private/$1') : file;
  const components = absolute.split('/').filter(Boolean);
  let current = '/', stat;
  for (const part of components) {
    current = path.join(current, part);
    stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) return null;
  }
  if (!stat || stat.isDirectory()) return 'folder';
  return stat.isFile() ? 'file' : null;
}

async function filePreview(file, savedKind, inspect = inspectPosixFile) {
  const ext = path.extname(file).toLowerCase();
  const type = localPath(file) ? await inspect(file).catch(() => null) : null;
  let kind = savedKind || 'file';
  if (type === 'folder' || /[\\/]$/.test(file)) kind = ext === '.app' ? 'application' : 'folder';
  else if (!savedKind && appExtensions.has(ext)) kind = 'application';
  else if (!savedKind && archiveExtensions.has(ext)) kind = 'archive';
  // 快捷方式和符号链接的图标可能引用远程资源，沿用类型图标。
  const systemIcon = !!type && !['.lnk', '.url', '.scf'].includes(ext);
  return {kind, systemIcon, mime:type === 'file' ? imageTypes[ext] : undefined};
}

async function previewKinds(files, inspect) {
  return Promise.all(files.slice(0, previewLimit).map(async file => (await filePreview(file, undefined, inspect)).kind));
}

function jpegSize(bytes) {
  if (bytes.readUInt16BE(0) !== 0xffd8) return;
  for (let offset = 2; offset + 4 <= bytes.length && bytes[offset] === 0xff;) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9 || offset + 2 > bytes.length) return;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) {
      return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
    }
    offset += length;
  }
}

function imageSize(bytes, mime) {
  if (bytes.length < 26) return;
  const tag = (start, length) => bytes.toString('latin1', start, start + length);
  if (mime === 'image/png' && bytes.readBigUInt64BE(0) === 0x89504e470d0a1a0an && tag(12, 4) === 'IHDR') {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  }
  if (mime === 'image/jpeg') return jpegSize(bytes);
  if (mime === 'image/gif' && ['GIF87a','GIF89a'].includes(tag(0, 6))) return [bytes.readUInt16LE(6), bytes.readUInt16LE(8)];
  if (mime === 'image/bmp' && tag(0, 2) === 'BM') {
    if (bytes.readUInt32LE(14) === 12) return [bytes.readUInt16LE(18), bytes.readUInt16LE(20)];
    if (bytes.readUInt32LE(14) >= 40) return [bytes.readInt32LE(18), Math.abs(bytes.readInt32LE(22))];
  }
  if (mime === 'image/webp' && tag(0, 4) === 'RIFF' && tag(8, 4) === 'WEBP') {
    const chunk = tag(12, 4);
    if (chunk === 'VP8X' && bytes.length >= 30) return [1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3)];
    if (chunk === 'VP8 ' && bytes.length >= 30 && tag(23, 3) === '\x9d\x01\x2a') return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff];
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const size = bytes.readUInt32LE(21);
      return [1 + (size & 0x3fff), 1 + ((size >>> 14) & 0x3fff)];
    }
  }
}

async function readPreviewImage(file, mime) {
  if (!mime || !localPath(file) || mime !== imageTypes[path.extname(file).toLowerCase()]) return null;
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 26 || stat.size > maxImageBytes) return null;
    // 按打开时的大小读取，同一文件随后增长也不能越过上限。
    const bytes = Buffer.allocUnsafeSlow(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const {bytesRead} = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) return null;
      offset += bytesRead;
    }
    const [width, height] = imageSize(bytes, mime) || [];
    if (!(width > 0 && height > 0 && Math.max(width, height) <= 16384 && width * height <= 24000000)) return null;
    return {bytes, mime};
  } catch {
    return null;
  } finally {
    if (handle) await handle.close();
  }
}

function fileEntry(paths) {
  const files = typeof paths === 'string' ? [paths] : paths;
  if (!Array.isArray(files) || !files.length || !files.every(file => typeof file === 'string' && file.length)) return null;
  const value = files.join('\n');
  return {kind:'files', files, value, text:value, title:files.map(file => path.win32.basename(file) || file).join('、')};
}

module.exports = { previewLimit, previewKinds, fileEntry, filePreview, localPath, imageTypes, readPreviewImage };
