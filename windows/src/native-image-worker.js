const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { installWorkerEnvironment } = require('./native-webworker');
const {applyMetadata,encodeTIFF}=require('./native-image-metadata');
let codecs,heicRaw;
const unpack=p=>p.replace('app.asar'+path.sep,'app.asar.unpacked'+path.sep);
async function loadCodecs(){return codecs??=await import(pathToFileURL(unpack(require.resolve('icodec/node'))).href);}
function decodeDataURL(value){const match=/^data:([^;,]+)?;base64,([\s\S]+)$/.exec(String(value));if(!match)throw Error('图片数据格式无效');if(match[2].length>134_000_000)throw Error('图片不能超过 100 MB');const bytes=Buffer.from(match[2],'base64');if(bytes.length>100_000_000)throw Error('图片不能超过 100 MB');return {mime:match[1]||'',bytes};}
async function decode(data){if(data.bytes[0]===137&&data.bytes.length>=24&&data.bytes.readUInt32BE(16)*data.bytes.readUInt32BE(20)>40_000_000)throw Error('图片像素超过 4000 万，请先缩小图片');const c=await loadCodecs();let kind;if(data.bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))kind='png';else if(data.bytes[0]===255&&data.bytes[1]===216)kind='jpeg';else if(data.bytes.subarray(4,8).toString()==='ftyp')kind='heic';else if(data.bytes.subarray(0,4).toString()==='RIFF')kind='webp';else if(data.bytes.subarray(0,2).toString()==='II'||data.bytes.subarray(0,2).toString()==='MM'){const UTIF=require('utif'),array=data.bytes.buffer.slice(data.bytes.byteOffset,data.bytes.byteOffset+data.bytes.byteLength),ifds=UTIF.decode(array);if(!ifds.length)throw Error('TIFF 没有图像');if(Number(ifds[0].t256?.[0])*Number(ifds[0].t257?.[0])>40_000_000)throw Error('图片像素超过 4000 万，请先缩小图片');UTIF.decodeImage(array,ifds[0]);return {width:ifds[0].width,height:ifds[0].height,depth:8,data:new Uint8ClampedArray(UTIF.toRGBA8(ifds[0]))};}else throw Error('暂时无法识别此图片格式');await c[kind].loadDecoder();const image=c[kind].decode(data.bytes);if(image.width*image.height>40_000_000)throw Error('图片像素超过 4000 万，请先缩小图片');return image;}
async function encode(payload){const input=decodeDataURL(payload.dataUrl);const image=await decode(input);const format=String(payload.format||'png').toLowerCase().replace('jpg','jpeg').replace('tif','tiff').replace('tifff','tiff');let bytes,mime='image/'+format;const quality=Math.max(1,Math.min(100,(Number(payload.quality)||.85)<=1?Number(payload.quality||.85)*100:Number(payload.quality)));
 if(format==='heic'||format==='heif'){
  if(!heicRaw){installWorkerEnvironment();const directory=path.dirname(unpack(require.resolve('icodec/node')));heicRaw=await import(pathToFileURL(path.join(directory,'heic.js')).href);await heicRaw.loadEncoder(fs.readFileSync(path.join(directory,'../dist/heic-enc.wasm')));}
  bytes=Buffer.from(heicRaw.encode(image,{quality,preset:'fast',complexity:25}));mime='image/heic';
 }else if(format==='tiff'){bytes=encodeTIFF(image,payload.removeMetadata===false&&payload.sourceDataUrl?decodeDataURL(payload.sourceDataUrl).bytes:null);}
 else if(['png','jpeg','webp'].includes(format)){const c=await loadCodecs();await c[format].loadEncoder();bytes=Buffer.from(c[format].encode(image,format==='jpeg'?{quality}:format==='png'?{level:2}:{quality}));}
 else throw Error('不支持的输出格式');
 if(payload.removeMetadata===false&&payload.sourceDataUrl&&format!=='tiff')bytes=applyMetadata(bytes,format,decodeDataURL(payload.sourceDataUrl).bytes);
 if(bytes.length>100_000_000)throw Error('输出图片超过 100 MB，请先缩小尺寸');
 return {dataUrl:`data:${mime};base64,`+bytes.toString('base64'),bytes:bytes.length,width:image.width,height:image.height,format};
}
parentPort.on('message',async({id,action,payload})=>{try{if(action!=='encode')throw Error('未知图片操作');parentPort.postMessage({id,result:await encode(payload)});}catch(error){parentPort.postMessage({id,error:error.message});}});
