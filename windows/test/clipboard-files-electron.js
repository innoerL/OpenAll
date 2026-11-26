const {app, BrowserWindow, nativeImage} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const fsSync = require('node:fs');
process.env.OPENALL_TEST_MODE = '1';
// 用缺少字号字段的旧版配置启动，验证升级后首次打开抽屉的默认字号。
process.env.OPENALL_TEST_USER_DATA = fsSync.mkdtempSync(path.join(os.tmpdir(), 'openall-clip-shelf-'));
const settingsFile = path.join(process.env.OPENALL_TEST_USER_DATA, 'settings.json');
fsSync.writeFileSync(settingsFile, JSON.stringify({clipboardPreferences:{retentionDays:90}}));
require('../src/main');

setTimeout(() => { console.error('文件剪贴板集成回归超时'); app.exit(1); }, 120000).unref();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const execute = (win, fn, ...args) => win.webContents.executeJavaScript(`(${fn})(...${JSON.stringify(args)})`);
async function until(fn, timeout = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw Error('等待剪贴板回归状态超时');
}

async function shelfFonts(shelf, layout, size) {
  await until(() => execute(shelf, (layout, size) => {
    const shelf = document.querySelector('.clipboard-shelf');
    return shelf?.dataset.layout === layout && shelf.dataset.cardFontSize === size && !!shelf.querySelector('.clip-content pre');
  }, layout, size));
  return execute(shelf, () => {
    const textCard = document.querySelector('.clip-type-bar[data-format="文本"]').closest('.clip-card');
    const font = element => parseFloat(getComputedStyle(element).fontSize);
    return {
      text:font(textCard.querySelector('.clip-content')),
      json:font(document.querySelector('.clip-content pre')),
      file:font(document.querySelector('.clip-file-name')),
      type:font(textCard.querySelector('.clip-type-bar strong')),
      time:font(textCard.querySelector('.clip-type-bar time')),
    };
  });
}

async function checkPreviewActions(shelf, page, photo, files, filesId) {
  const text = '预览全文\n' + '保留原始内容和换行。\n'.repeat(2300) + '最后一行';
  const original = nativeImage.createFromPath(photo);
  const value = original.toPNG().toString('base64');
  const thumbnail = original.resize({width:8}).toPNG().toString('base64');
  const [textId, imageId] = await execute(shelf, async (text, value, thumbnail) => {
    await openall.windowAction('smokeFixture', {clipboard:[
      {kind:'text', text, value:text}, {kind:'image', title:'预览原图', value, thumbnail}
    ]});
    const history = await openall.history();
    return [history.find(row => row.truncated && row.text.startsWith('预览全文')).id,
      history.find(row => row.title === '预览原图' && row.value === thumbnail).id];
  }, text, value, thumbnail);

  async function openPreview(id) {
    await execute(shelf, () => openall.windowAction('showClipboard'));
    await until(() => shelf.isFocused());
    await until(() => execute(shelf, id => {
      const index = OpenAllApp.controller.getItems().findIndex(row => row.id === id);
      const card = document.querySelectorAll('.clip-card')[index];
      card?.click();
      return !!card && document.activeElement === card;
    }, id));
    shelf.webContents.sendInputEvent({type:'keyDown', keyCode:'Space'});
    shelf.webContents.sendInputEvent({type:'keyUp', keyCode:'Space'});
    const preview = await page('clipboardPreview');
    await until(() => preview.isFocused());
    return preview;
  }
  async function click(win, selector, label) {
    assert.ok(await execute(win, (selector, label) => {
      const button = [...document.querySelectorAll(selector)].find(el => el.textContent.trim() === label);
      if (!button || button.disabled) return false;
      const rect = button.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.left < 0 || rect.right > innerWidth || rect.top < 0 || rect.bottom > innerHeight) return false;
      button.click();
      return true;
    }, selector, label), label + '可见且可执行');
  }
  const footer = '.clip-preview-footer button';
  const clipboardText = '预览打开后新复制的内容';
  for (const [id, kind] of [[textId, 'text'], [imageId, 'image'], [filesId, 'files']]) {
    const preview = await openPreview(id);
    if (kind === 'image') {
      // 历史清理后仍应交付窗口中正在预览的原图。
      await execute(shelf, id => openall.clipboardAction('delete', {ids:[id]}), id);
    }
    await execute(preview, text => openall.copyText(text), clipboardText);
    await click(preview, footer, '对内容操作');
    const selection = await page('selection');
    await until(() => (preview.isDestroyed() || !preview.isVisible()) && selection.isVisible() && selection.isFocused());
    assert.equal(shelf.isVisible(), false, '操作页打开后收起剪贴板抽屉');
    await until(() => execute(selection, kind => OpenAllApp.controller?.getContent?.().kind === kind
      && document.activeElement.matches('.selection-action-list'), kind));
    assert.equal(await execute(selection, () => openall.readText()), clipboardText);
    if (kind === 'text') {
      assert.ok(await execute(selection, text => document.querySelector('.selection-preview').textContent === text
        && !!document.querySelector('[data-action=translate]'), text), '操作页收到完整长文本');
    } else if (kind === 'image') {
      assert.equal(await execute(selection, () => document.querySelector('.selection-preview img').src), 'data:image/png;base64,' + value);
      assert.ok(await execute(selection, () => !!document.querySelector('[data-action=recognizeText]')));
    } else {
      assert.deepEqual(await execute(selection, () => OpenAllApp.controller.getContent().files), files);
      await execute(selection, () => document.querySelector('[data-action=copy]').dispatchEvent(new MouseEvent('dblclick', {bubbles:true})));
      await until(() => !selection.isVisible());
      assert.equal(await execute(shelf, () => openall.readText()), files.join('\n'));
    }
    selection.close();
  }

  let preview = await openPreview(textId);
  await click(preview, footer, '复制全文');
  await until(() => execute(preview, text => openall.readText().then(copied => copied === text), text));
  await click(preview, footer, '用工具打开 ▾');
  await click(preview, '.context-menu button', 'JSON 工具');
  const editor = await page('json');
  assert.ok(await execute(editor, text => OpenAllApp.controller.getText() === text, text));
  await execute(editor, () => OpenAllApp.controller.setText(''));
  preview.close();
  editor.show(); editor.focus();
  await until(() => editor.isFocused());
  preview = await openPreview(textId);
  await click(preview, footer, '粘贴此项');
  await until(() => preview.isDestroyed() || !preview.isVisible());
  await until(() => execute(editor, text => OpenAllApp.controller.getText() === text, text));
}

app.whenReady().then(async () => {
  const page = name => until(async () => {
    const win = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('?page=' + name));
    return win && await execute(win, () => !!window.OpenAllApp?.ready).catch(() => false) && win;
  }, name === 'search' ? 25000 : 10000);
  const search = await page('search');
  const legacy = await execute(search, async () => (await openall.settings()).clipboardPreferences);
  assert.equal(legacy.cardFontSize, 'large');
  assert.equal(legacy.retentionDays, 90);
  await execute(search, () => openall.windowAction('showClipboard'));
  let shelf = await page('clipboard');
  if (process.platform === 'darwin') app.focus({steal:true});
  assert.ok(await execute(shelf, () => document.activeElement.matches('.clipboard-search') &&
    !document.querySelector('.clip-card')), '空历史打开时焦点落在搜索框');
  await execute(search, () => openall.windowAction('smokeFixture', {
    clipboard:['唤出焦点验证旧卡片', '唤出焦点验证新卡片'].map(text => ({kind:'text', text, value:text})),
  }));
  shelf.destroy();
  await execute(search, () => openall.windowAction('showClipboard'));
  shelf = await page('clipboard');
  if (process.platform === 'darwin') app.focus({steal:true});
  const press = key => execute(shelf, key => document.activeElement.dispatchEvent(
    new KeyboardEvent('keydown', {key, bubbles:true, cancelable:true}),
  ), key);
  const firstHasFocus = text => execute(shelf, text => {
    const track = document.querySelector('.clip-track'), first = track.querySelector('.clip-card');
    return first?.matches('[aria-selected=true]') && document.activeElement === first &&
      first.querySelector('.clip-content').textContent === text && !track.scrollLeft && !track.scrollTop &&
      track.querySelectorAll('.clip-card[aria-selected=true]').length === 1;
  }, text);
  await until(() => firstHasFocus('唤出焦点验证新卡片'));
  await press('ArrowRight');
  await until(() => execute(shelf, () => document.activeElement === document.querySelectorAll('.clip-card')[1]));
  await press('Escape');
  await until(() => !shelf.isVisible());
  await execute(search, () => openall.windowAction('smokeFixture', {
    clipboard:[{kind:'text', text:'窗口隐藏时新复制的卡片', value:'窗口隐藏时新复制的卡片'}],
  }));
  await execute(search, () => openall.windowAction('showClipboard'));
  await until(() => firstHasFocus('窗口隐藏时新复制的卡片'));
  await press('z');
  await until(() => execute(shelf, () => document.activeElement.matches('.clipboard-search') &&
    document.activeElement.value.toLowerCase() === 'z' && !document.querySelector('.clip-card')));
  await press('Escape');
  await until(() => !shelf.isVisible());
  // 刻意让旧记录排在首位，验证默认选中与实际显示位置一致。
  const reversed = (await execute(search, () => openall.history())).reverse();
  shelf.webContents.send('clipboard-changed', reversed);
  await execute(search, () => openall.windowAction('showClipboard'));
  await until(() => firstHasFocus(reversed[0].text));
  assert.equal(await execute(shelf, () => document.querySelector('.clipboard-search').value), '');
  await execute(shelf, () => openall.clipboardAction('setLayout', {layout:'list'}));
  await until(() => execute(shelf, () => document.querySelector('.clipboard-shelf').dataset.layout === 'list'));
  await press('ArrowDown');
  await until(() => execute(shelf, () => document.activeElement === document.querySelectorAll('.clip-card')[1]));
  await press('Escape');
  await until(() => !shelf.isVisible());
  await execute(search, () => openall.windowAction('showClipboard'));
  await until(() => firstHasFocus(reversed[0].text));
  const outside = new BrowserWindow({show:false});
  await outside.loadURL('about:blank');
  outside.show(); outside.focus();
  await until(() => outside.isFocused() && !shelf.isVisible());
  await execute(search, () => openall.windowAction('showClipboard'));
  await until(() => firstHasFocus(reversed[0].text));
  await press('Enter');
  await until(() => !shelf.isVisible());
  assert.equal(await execute(shelf, () => openall.readText()), reversed[0].text, '无粘贴目标时回车只复制');
  outside.close();
  await execute(search, () => openall.windowAction('showClipboard'));
  await execute(shelf, () => openall.clipboardAction('clear', {includeFavorites:true}));
  console.log('剪贴板唤出回归通过：首卡、首行、直接搜索、失焦收起、无目标回车复制后可再次唤出');
  if (process.platform === 'darwin') app.focus({steal:true});
  shelf.focus();
  await until(() => BrowserWindow.getFocusedWindow() === shelf);

  const root = app.getPath('userData'), archive = path.join(root, '备份 #1.zip'), folder = path.join(root, '资料夹');
  const missing = path.join(root, '已删除.exe'), other = path.join(root, '第四项.txt');
  await fs.writeFile(archive, 'zip');
  await fs.mkdir(folder);
  const original = app.getFileIcon.bind(app);
  let releaseIcons;
  const gate = new Promise(resolve => { releaseIcons = resolve; });
  app.getFileIcon = async (...args) => { await gate; return original(...args); };
  const multiple = [folder, archive, missing, other];
  await execute(shelf, () => openall.clipboardAction('setLayout', {layout:'list'}));
  const history = await execute(shelf, async (one, many) => {
    await openall.windowAction('smokeFixture', {fileDrops:[one, many]});
    return openall.history();
  }, archive, multiple);
  assert.deepEqual(history.map(r => r.files), [multiple, [archive]]);
  releaseIcons();
  await until(() => execute(shelf, () => [...document.querySelectorAll('.clip-files')].length === 2
    && [...document.querySelectorAll('.clip-files')].every(row => !!row.querySelector('.clip-file-icon img'))));
  assert.ok(await execute(shelf, () => {
    const rows = [...document.querySelectorAll('.clip-files')], multi = rows.find(r => !r.classList.contains('single-file'));
    return multi.querySelector('.clip-file-name').textContent === '资料夹' && multi.querySelector('.clip-file-total').textContent === '共 4 项' &&
      multi.querySelectorAll('.clip-file-icon img').length === 1 && multi.querySelector('.clip-file-row:nth-child(2)').getBoundingClientRect().height === 0;
  }));
  await execute(shelf, () => openall.clipboardAction('setLayout', {layout:'cards'}));
  await until(() => execute(shelf, () => {
    const rows = [...document.querySelectorAll('.clip-files:not(.single-file) .clip-file-icon')];
    return rows[0]?.dataset.kind === 'folder' && !!rows[0].querySelector('img') && !!rows[1].querySelector('img') &&
      rows[2]?.dataset.kind === 'application' && !!rows[2].querySelector('svg') &&
      document.querySelector('.clip-file-rest')?.textContent === '另 1 项';
  }));
  await fs.unlink(archive);
  const restored = await execute(shelf, async id => {
    await openall.clipboardAction('copy', {ids:[id]});
    return openall.windowAction('smokeFixture', {readFiles:true});
  }, history[0].id);
  assert.deepEqual(restored, multiple);
  const photo = path.join(root, '复制的照片 #1.png');
  const broken = path.join(root, '损坏.png');
  const pixels = Buffer.alloc(128 * 64 * 4);
  for (let i = 0; i < 128 * 64; i++) {
    pixels.set(i % 128 < 64 ? [30, 60, 220, 255] : [30, 180, 60, 255], i * 4);
  }
  await fs.writeFile(photo, nativeImage.createFromBitmap(pixels, {width:128, height:64}).toPNG());
  await fs.writeFile(broken, '损坏的图片样例');
  const photoID = await execute(shelf, async (photo, broken) => {
    await openall.windowAction('smokeFixture', {fileDrops:[[photo, broken], [photo]]});
    return (await openall.history())[0].id;
  }, photo, broken);
  await until(() => execute(shelf, () => {
    const images = [...document.querySelectorAll('.clip-file-icon.has-thumbnail img')];
    return images.length === 2 && images.every(image => image.complete && image.naturalWidth > 0);
  }));
  assert.ok(await execute(shelf, () => {
    const card = document.querySelector('.clip-files.single-file .has-thumbnail').closest('.clip-card');
    const row = card.querySelector('.clip-file-row');
    const img = row.querySelector('img');
    const canvas = document.createElement('canvas');
    canvas.width = 2; canvas.height = 1;
    const context = canvas.getContext('2d');
    context.drawImage(img, 0, 0, 2, 1);
    const [r1,g1,,,r2,g2] = context.getImageData(0, 0, 2, 1).data;
    const bar = card.querySelector('.clip-type-bar').getBoundingClientRect();
    const name = row.querySelector('.clip-file-name').getBoundingClientRect();
    const search = document.querySelector('.clipboard-search').getBoundingClientRect();
    const gap = card.getBoundingClientRect().top - search.bottom;
    return img.naturalWidth === 2 * img.naturalHeight && r1 > g1 + 80 && g2 > r2 + 70 &&
      img.getBoundingClientRect().height > 65 && name.bottom <= bar.top && gap >= 4 && gap <= 16 &&
      card.querySelector('.clip-file-name').textContent === '复制的照片 #1.png' &&
      !document.querySelector('.clip-files:not(.single-file) .clip-file-row:nth-child(2) .has-thumbnail');
  }), '大卡按原比例显示真实图像和文件名，工具栏与卡片间距紧凑');
  await execute(shelf, () => openall.clipboardAction('setLayout', {layout:'list'}));
  await until(() => execute(shelf, () => {
    const slot = document.querySelector('.clip-files.single-file .has-thumbnail');
    return !!slot && slot.getBoundingClientRect().height <= 30;
  }));
  assert.deepEqual(await execute(shelf, async id => {
    await openall.clipboardAction('copy', {ids:[id]});
    return openall.windowAction('smokeFixture', {readFiles:true});
  }, photoID), [photo]);
  await execute(shelf, id => openall.clipboardAction('preview', {ids:[id]}), photoID);
  const detail = await page('clipboardPreview');
  await until(() => execute(detail, () => {
    const image = document.querySelector('.clip-preview .has-file-image img');
    return image?.complete && image.naturalWidth === image.naturalHeight * 2 && image.naturalWidth > 0;
  }));
  console.log('文件剪贴板通过连续快照、延迟图标、列表懒加载、卡片分类、缺失路径和文件列表回写回归');
  detail.close();
  await execute(shelf, async () => {
    const clipboard = ['字号回归普通文本','{"属性":"字号回归"}'].map(text => ({kind:'text', text, value:text}));
    await openall.windowAction('smokeFixture', {clipboard});
    await openall.clipboardAction('setLayout', {layout:'cards'});
  });
  const large = {text:14, json:12, file:14, type:12, time:11};
  const list = {text:13, json:13, file:14, type:11, time:11};
  assert.deepEqual(await shelfFonts(shelf, 'cards', 'large'), large);
  await execute(shelf, () => openall.windowAction('openSettings'));
  const settings = await page('settings');
  await execute(settings, () => [...document.querySelectorAll('.settings-nav')].find(tab => tab.textContent === '剪贴板').click());
  await until(() => execute(settings, () => [...document.querySelectorAll('label')].some(label => label.textContent === '卡片字号' && label.control)));
  for (const [size, text, json] of [['medium',13,11], ['small',12,10], ['large',14,12]]) {
    await execute(settings, size => {
      const field = [...document.querySelectorAll('label')].find(label => label.textContent === '卡片字号').control;
      field.value = size;
      field.dispatchEvent(new Event('change', {bubbles:true}));
    }, size);
    const expected = {...large, text, json, file:text};
    assert.deepEqual(await shelfFonts(shelf, 'cards', size), expected, size + ' 大卡字号');
    const normalized = await execute(search, async () => (await openall.settings()).clipboardPreferences);
    assert.equal(normalized.cardFontSize, size);
    assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).clipboardPreferences.cardFontSize, size);
    if (size === 'small') {
      shelf.destroy();
      await execute(settings, () => openall.windowAction('showClipboard'));
      shelf = await page('clipboard');
      assert.deepEqual(await shelfFonts(shelf, 'cards', size), expected, '新窗口恢复已保存的小字号');
    }
    await execute(shelf, () => openall.clipboardAction('setLayout', {layout:'list'}));
    assert.deepEqual(await shelfFonts(shelf, 'list', size), list, size + ' 列表字号');
    await execute(shelf, () => openall.clipboardAction('setLayout', {layout:'cards'}));
  }
  console.log('剪贴板卡片字号通过设置页三档切换、实际字体、列表、旧设置默认值、落盘及新窗口回归');
  await checkPreviewActions(shelf, page, photo, multiple, history[0].id);
  console.log('空格预览通过长文本、原图、多文件选择操作、独立剪贴板和原有复制、粘贴及工具入口回归');
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
