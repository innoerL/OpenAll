const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');

const aliases = [
  {
    "name": "小红书",
    "keywords": [
      "xhs",
      "xiaohongshu",
      "hongshu"
    ],
    "url": "https://www.xiaohongshu.com/search_result?keyword={query}"
  },
  {
    "name": "Google",
    "keywords": [
      "gg",
      "google",
      "g"
    ],
    "url": "https://www.google.com/search?q={query}"
  },
  {
    "name": "百度",
    "keywords": [
      "bd",
      "baidu",
      "b"
    ],
    "url": "https://www.baidu.com/s?wd={query}"
  },
  {
    "name": "GitHub",
    "keywords": [
      "gh",
      "github",
      "git"
    ],
    "url": "https://github.com/search?q={query}"
  },
  {
    "name": "知乎",
    "keywords": [
      "zh",
      "知乎",
      "zhihu"
    ],
    "url": "https://www.zhihu.com/search?type=content&q={query}"
  },
  {
    "name": "X (Twitter)",
    "keywords": [
      "x",
      "twitter",
      "推特"
    ],
    "url": "https://x.com/search?q={query}"
  },
  {
    "name": "Facebook",
    "keywords": [
      "fb",
      "facebook",
      "脸书"
    ],
    "url": "https://www.facebook.com/search/top?q={query}"
  },
  {
    "name": "YouTube",
    "keywords": [
      "yt",
      "youtube",
      "油管"
    ],
    "url": "https://www.youtube.com/results?search_query={query}"
  },
  {
    "name": "维基百科",
    "keywords": [
      "wiki",
      "wikipedia",
      "维基"
    ],
    "url": "https://zh.wikipedia.org/w/index.php?search={query}"
  }
];
const defaults = {
  search:'Control+Space',clipboard:'Control+Shift+V',stack:'Control+Shift+C',selection:'Control+Alt+A',
  searchShortcutMode:'combo',doubleTap:'Alt',pinyinEnabled:true,searchFiles:false,
  chromeBookmarks:false,chromeHistory:false,chromePath:'',aliases,commandAliases:{},
  theme:'dark',backgroundHex:'#242626',accentHex:'#d8c19e',launchAtLogin:false,
  clipboardPreferences:{enabled:true,maxItems:300,maxItemBytes:20_000_000,retentionDays:30,directPaste:true,shelfLayout:'cards',cardFontSize:'large',
    ignoreApplications:[],plainTextByDefault:false,pausedUntil:null,pinboards:['收藏'],pinboardColors:{收藏:'blue'}}
};
function readJSON(file, fallback) { try { return JSON.parse(fs.readFileSync(file,'utf8')); } catch { return structuredClone(fallback); } }
class JSONStore {
  constructor(dir) { this.dir=dir; fs.mkdirSync(dir,{recursive:true}); this.pending=new Map(); this.serial=Promise.resolve(); }
  read(name,fallback) { return readJSON(path.join(this.dir,name+'.json'),fallback); }
  write(name,value) {
    const text=JSON.stringify(value); const file=path.join(this.dir,name+'.json');
    this.serial=this.serial.catch(()=>{}).then(async()=>{const temporary=file+'.tmp';await fsp.writeFile(temporary,text);await fsp.rename(temporary,file);});
    return this.serial;
  }
  async flush() { await this.serial; }
}
function normalizeSettings(saved={}) {
  const s={...structuredClone(defaults),...saved};
  s.clipboardPreferences={...defaults.clipboardPreferences,...saved.clipboardPreferences};
  const p=s.clipboardPreferences;
  p.shelfLayout = p.shelfLayout === 'list' ? 'list' : 'cards';
  p.cardFontSize = ['small','medium','large'].includes(p.cardFontSize) ? p.cardFontSize : 'large';
  p.maxItems=Math.min(10000,Math.max(10,Number(p.maxItems)||300));
  p.maxItemBytes=Math.min(100_000_000,Math.max(100000,Number(p.maxItemBytes)||20_000_000));
  p.retentionDays=Math.min(3650,Math.max(1,Number(p.retentionDays)||30));
  p.pinboards=Array.isArray(p.pinboards)?p.pinboards.filter(x=>typeof x==='string').slice(0,100):['收藏'];
  p.ignoreApplications=Array.isArray(p.ignoreApplications)?p.ignoreApplications.filter(x=>typeof x==='string'):[];
  s.aliases=Array.isArray(s.aliases)?s.aliases.filter(a=>a&&typeof a.name==='string'&&Array.isArray(a.keywords)&&/^https?:\/\//i.test(a.url||'')):structuredClone(aliases);
  s.commandAliases=s.commandAliases&&typeof s.commandAliases==='object'&&!Array.isArray(s.commandAliases)?s.commandAliases:{};
  delete s.glass;
  delete s.searchInterfaceSize;
  return s;
}
function classify(record) {
  if(record.kind==='image')return '图片';if(record.kind==='files')return '文件';
  const text=record.text??record.value??'';
  if(/^https?:\/\/\S+$/i.test(text.trim()))return '链接';
  if(text.length<1_000_000&&/^\s*[\[{]/.test(text))try{JSON.parse(text);return 'JSON';}catch{}
  if(/(^#{1,6}\s|^\s*```|^\s*[-*+]\s|^>\s|\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*)/m.test(text.slice(0,20000)))return 'Markdown';
  return record.html?'HTML':record.rtf?'富文本':'文本';
}
class ClipboardStore {
  constructor(store, preferences) {
    this.store=store; this.preferences=preferences;this.directory=path.join(store.dir,'Clipboard');fs.mkdirSync(this.directory,{recursive:true});
    this.records=store.read('clipboard',[]).filter(x=>x&&typeof x.hash==='string').map(x=>({...x,id:x.id||x.hash,sourceName:x.sourceName||x.source||'',tags:x.tags||[],favorite:!!x.favorite}));
    this.stack={active:false,ids:[]};this.cleanup();
  }
  cleanup() {
    const now=Date.now(),p=this.preferences(),before=this.records;
    const maxItems = Math.trunc(p.maxItems);
    let regularCount = 0;
    // 同一毫秒的记录沿用插入顺序，收藏状态不改变最近复制的顺序。
    this.records = before.filter(record => record.favorite ||
      ((now - record.time) < p.retentionDays * 86400000 && regularCount++ < maxItems))
      .sort((a, b) => b.time - a.time);
    const kept=new Set(this.records.map(x=>x.id));for(const record of before)if(!kept.has(record.id)&&record.contentFile)fsp.unlink(path.join(this.directory,path.basename(record.contentFile))).catch(()=>{});this.stack.ids=this.stack.ids.filter(id=>kept.has(id));
    this.store.write('clipboard',this.records);
  }
  list() { return this.records.map(({contentFile,...x})=>x); }
  async full(id) {
    const r=this.records.find(x=>x.id===id||x.hash===id);if(!r)return null;
    if(!r.contentFile)return {...r,text:r.text??(r.kind==='image'?'':r.value)};
    const data=await fsp.readFile(path.join(this.directory,path.basename(r.contentFile)));
    const value=r.kind==='image'?data.toString('base64'):data.toString('utf8');
    return {...r,value,text:r.kind==='image'?'':value,truncated:false};
  }
  async add(input) {
    const p=this.preferences();const payload=input.kind==='image'?Buffer.from(input.value,'base64'):Buffer.from(input.text??input.value??JSON.stringify(input.files||[]));
    if(!payload.length||payload.length>p.maxItemBytes)return null;
    const hash=crypto.createHash('sha256').update(input.kind+':').update(payload).digest('hex');
    const old=this.records.find(x=>x.hash===hash);
    const r={...input,hash,id:hash,time:Date.now(),sourceName:input.sourceName||'',favorite:old?.favorite||false,tags:old?.tags||[],title:input.title||String(input.text||input.value||'').replace(/\s+/g,' ').slice(0,160)};
    r.type=classify(input);
    if(input.kind==='image'||payload.length>64000){r.contentFile=hash+(input.kind==='image'?'.png':'.txt');await fsp.writeFile(path.join(this.directory,r.contentFile),payload);r.value=input.kind==='image'?(input.thumbnail||input.value):payload.toString('utf8').slice(0,16000);r.text=input.kind==='image'?'':r.value;r.truncated=input.kind!=='image';}
    this.records=[r,...this.records.filter(x=>x.hash!==hash)];
    if(this.stack.active&&!this.stack.ids.includes(hash))this.stack.ids.push(hash);
    this.cleanup();return r;
  }
  async delete(ids) {
    const removed=this.records.filter(r=>ids.includes(r.id)||ids.includes(r.hash));
    this.records=this.records.filter(r=>!removed.includes(r));this.stack.ids=this.stack.ids.filter(id=>!ids.includes(id));
    await Promise.all(removed.filter(r=>r.contentFile).map(r=>fsp.unlink(path.join(this.directory,path.basename(r.contentFile))).catch(()=>{})));
    await this.store.write('clipboard',this.records);return this.list();
  }
  change(ids,fn) { for(const record of this.records)if(ids.includes(record.id)||ids.includes(record.hash))fn(record);this.store.write('clipboard',this.records);return this.list(); }
  stackInfo() { return {active:this.stack.active,items:this.stack.ids.map(id=>this.records.find(x=>x.id===id)).filter(Boolean)}; }
}
function formatDate(date,pattern='yyyy-MM-dd') {
  const n=v=>String(v).padStart(2,'0');
  const values={yyyy:String(date.getFullYear()),yy:String(date.getFullYear()).slice(-2),MM:n(date.getMonth()+1),dd:n(date.getDate()),HH:n(date.getHours()),hh:n(date.getHours()%12||12),mm:n(date.getMinutes()),ss:n(date.getSeconds()),SSS:String(date.getMilliseconds()).padStart(3,'0'),M:String(date.getMonth()+1),d:String(date.getDate()),H:String(date.getHours()),m:String(date.getMinutes()),s:String(date.getSeconds()),a:date.getHours()<12?'上午':'下午'};
  return pattern.replace(/'([^']*)'|yyyy|SSS|yy|MM|dd|HH|hh|mm|ss|[MdHmsa]/g,(m,quoted)=>quoted??values[m]??m);
}
function snippetExpansionParts(body,clipboard,now=new Date()) {
  const template = String(body);
  const parts = [];
  let end = 0;
  for (const match of template.matchAll(/\{\{(?:(date|time)(?::([^{}]{1,128}))?|(clipboard))\}\}/g)) {
    if (match.index > end) parts.push({text:template.slice(end,match.index),variable:false});
    const text = match[3] ? String(clipboard ?? '') : formatDate(now,match[2] || (match[1] === 'date' ? 'yyyy-MM-dd' : 'HH:mm'));
    parts.push({text,variable:true});
    end = match.index + match[0].length;
  }
  if (end < template.length) parts.push({text:template.slice(end),variable:false});
  return parts;
}
function expandSnippet(body,clipboard,now) { return snippetExpansionParts(body,clipboard,now).map(part=>part.text).join(''); }
class SnippetStore {
  constructor(store){this.store=store;this.items=store.read('snippets',[]);}
  save(item){const key=String(item.keyword||'').trim().toLowerCase();if(!key||/\s/.test(key)||!item.body)throw Error('片段需要不含空格的关键词和内容');if(this.items.some(x=>x.id!==item.id&&x.keyword.toLowerCase()===key))throw Error('关键词已存在');const value={id:item.id||crypto.randomUUID(),keyword:key,name:String(item.name||key).trim(),body:String(item.body),createdAt:item.createdAt||Date.now()};const i=this.items.findIndex(x=>x.id===value.id);if(i<0)this.items.push(value);else this.items[i]=value;this.store.write('snippets',this.items);return value;}
  remove(id){this.items=this.items.filter(x=>x.id!==id);this.store.write('snippets',this.items);return this.items;}
}
module.exports={JSONStore,ClipboardStore,SnippetStore,defaults,normalizeSettings,classify,formatDate,expandSnippet,snippetExpansionParts};
