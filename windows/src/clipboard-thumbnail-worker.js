self.onmessage = async ({data:{bytes, mime, edge}}) => {
  let bitmap;
  try {
    // 对动画取首帧。位图解码器会应用照片方向，透明通道由 PNG 保留。
    bitmap = await createImageBitmap(new Blob([bytes], {type:mime}));
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);
    const png = await canvas.convertToBlob({type:'image/png'});
    self.postMessage(new FileReaderSync().readAsDataURL(png));
  } catch {
    self.postMessage('');
  } finally {
    bitmap?.close();
  }
};
