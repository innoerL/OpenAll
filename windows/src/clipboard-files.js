const fs = require('node:fs/promises');
const path = require('node:path');

const previewLimit = 3;
const appExtensions = new Set(['.exe', '.msi', '.msix', '.app', '.lnk']);
const archiveExtensions = new Set(['.zip', '.7z', '.rar', '.gz', '.tgz', '.bz2', '.xz', '.tar', '.zst', '.cab', '.dmg', '.pkg']);

function localPath(file) {
  return typeof file === 'string' && path.isAbsolute(file) && !/^[\\/]{2}/.test(file);
}

async function filePreview(file, savedKind) {
  const ext = path.extname(file).toLowerCase();
  const stat = localPath(file) ? await fs.lstat(file).catch(() => null) : null;
  let kind = savedKind || 'file';
  if (stat?.isDirectory() || /[\\/]$/.test(file)) kind = ext === '.app' ? 'application' : 'folder';
  else if (!savedKind && appExtensions.has(ext)) kind = 'application';
  else if (!savedKind && archiveExtensions.has(ext)) kind = 'archive';
  // 快捷方式和符号链接的图标可能引用远程资源，沿用类型图标。
  const systemIcon = !!stat && !stat.isSymbolicLink() && !['.lnk', '.url', '.scf'].includes(ext);
  return {kind, systemIcon};
}

async function previewKinds(files) {
  return Promise.all(files.slice(0, previewLimit).map(async file => (await filePreview(file)).kind));
}

function fileEntry(paths) {
  const files = typeof paths === 'string' ? [paths] : paths;
  if (!Array.isArray(files) || !files.length || !files.every(file => typeof file === 'string' && file.length)) return null;
  const value = files.join('\n');
  return {kind:'files', files, value, text:value, title:files.map(file => path.win32.basename(file) || file).join('、')};
}

module.exports = { previewLimit, previewKinds, fileEntry, filePreview };
