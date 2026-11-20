const path = require('node:path');
const crypto = require('node:crypto');
const { pinyin } = require('pinyin-pro');
const { expandSnippet } = require('./stores');
const commands = [
 ['gold','金价桌台',['金价','金价桌台','gold','gold price'],'国际金价、周大福牌价、历史走势与七日展望','chart'],
 ['translate','翻译',['翻译','translate'],'打开有道翻译 · 输入 翻译 内容','translate'],
 ['comparison','文本对比',['文本对比','文本','wenben','diff','diff2','文本对比 V2','diff v2'],'左右直接编辑，并在原处查看差异','columns'],
 ['json','JSON 工具',['json','json格式化'],'校验、键名自然排序与转义','braces'],
 ['unicode','Unicode 转换',['unicode','中文编码','unicode转中文','中文转unicode'],'中文与 Unicode 转义互转','unicode'],
 ['markdown','Markdown 编辑器',['mark','markdown'],'编辑并实时预览 Markdown','markdown'],
 ['id','身份证测试号',['身份证','idgen'],'按地区、生日和性别生成测试号','person'],
 ['manual','Shell 与 Java 命令手册',['命令','shell','java','alias','alas'],'常用命令与服务器别名示例','terminal'],
 ['image','图片处理',['图片快处理','image','图片处理'],'调整尺寸、压缩、转换格式和移除元数据','image'],
 ['converter','开发者转换',['转换','时间单位','cron','ascii','converter'],'时间单位、Cron 表达式与 ASCII 码表','convert'],
 ['configDiff','结构化配置对比',['配置对比','配置差异','config diff'],'比较 JSON、YAML 和 properties 的键路径','columns'],
 ['explain','SQL 执行计划',['执行计划','explain','sql计划'],'阅读 PostgreSQL 与 MySQL 的 EXPLAIN 结果','chart'],
 ['logTimeline','日志时间线',['日志时间线','日志聚合','log timeline'],'识别字段后选择聚合键和时间字段','list'],
 ['sqlRestore','SQL 参数还原',['SQL参数','参数还原','sql restore'],'将占位符与参数日志合成调试语句','braces'],
 ['configFormat','配置格式化',['配置格式整理','YAML格式化','Properties格式化'],'YAML 缩进与 Properties 键值排版','sliders'],
 ['sqlFormat','SQL 格式化',['SQL格式化','sql format'],'分句换行、关键字大写','database'],
 ['clipboard','剪贴板历史',['剪贴板','clipboard','粘贴板'],'浏览、搜索并粘贴剪贴板记录','clipboard'],
 ['stack','复制堆栈',['堆栈','stack'],'连续复制，按顺序粘贴','stack'],
 ['selection','对选中内容操作',['选中','selection'],'对选中文字、文件或图片进行处理','cursor'],
 ['settings','设置',['设置','settings'],'快捷键、搜索、剪贴板与权限','settings'],
 ['permissions','权限与隐私',['权限','permissions'],'查看辅助功能与文件权限状态','lock'],
 ['diagnostics','诊断',['诊断','状态','diagnostics'],'查看快捷键、索引和剪贴板状态','pulse'],
 ['snippets','常用片段',['片段','模板','snippets'],'管理可快速粘贴的文本','text'],
 ['linkAliases','网址别名',['网址别名','网站','link aliases'],'管理常用网站与搜索模板','link'],
 ['commandAliases','功能别名',['功能别名','命令别名'],'自定义内置功能的搜索词','command']
].map(([id,title,keywords,detail,symbol])=>({id,title,keywords,detail,symbol,type:'tool',value:id,rank:94}));
const documents=new Set('pdf doc docx docm dot dotx dotm rtf rtfd txt text md markdown pages xls xlsx xlsm xlsb xlt xltx csv tsv numbers ppt pptx pptm pot potx key keynote odt ods odp xmind mm mindnode opml epub mobi azw azw3 djvu'.split(' '));
const images=new Set('jpg jpeg jpe png gif heic heif tif tiff bmp webp avif svg svgz ico icns psd psb ai eps raw dng cr2 cr3 nef arw orf rw2 raf'.split(' '));
const extensions=new Set([...documents,...images,...'json jsonl ndjson yaml yml toml xml properties ini env conf config log sql swift c cc cpp h hpp m rs go java kt kts js jsx ts tsx py ipynb rb php sh zsh bash fish lua r cs css scss less vue svelte html htm zip rar 7z tar tar.gz gz bz2 xz zst dmg iso pkg app exe msi mp3 wav flac aac ogg m4a mp4 mov mkv webm avi m4v srt vtt sqlite db'.split(' ')]);
function fileRequest(input,reserved=[]) {
 const text=input.trim(),m=/^(\S+)(?:\s+(.*))?$/s.exec(text);if(!m)return null;const prefix=m[1].toLowerCase(),term=(m[2]||'').trim();
 if(['文件','file','files'].includes(prefix))return {term,kind:'all',title:'文件'};
 if(['文档','document','documents','docs'].includes(prefix))return {term,kind:'documents',title:'文档'};
 if(['图片','images','photos'].includes(prefix))return {term,kind:'images',title:'图片'};
 if(!term||prefix!=='json'&&reserved.some(x=>x.toLowerCase()===text.toLowerCase()))return null;
 const suffix=prefix.replace(/^\./,'');if(!/^[a-z0-9_+][a-z0-9_+.-]{0,31}$/.test(suffix)||suffix.endsWith('.'))return null;
 if(!prefix.startsWith('.')&&!extensions.has(suffix))return null;return {term,kind:'extension',extension:suffix,title:'.'+suffix+' 文件'};
}
function matchesFile(item,filter){if(filter.kind==='all')return true;if(item.isDirectory)return false;const lower=item.title.toLowerCase();return filter.kind==='extension'?lower.endsWith('.'+filter.extension):[...(filter.kind==='images'?images:documents)].some(x=>lower.endsWith('.'+x));}
const phonetic=new Map();
function folded(text){if(phonetic.has(text))return phonetic.get(text);const syllables=pinyin(text,{toneType:'none',type:'array',nonZh:'consecutive'});const value=[syllables.join('').replace(/[^a-z0-9]/gi,'').toLowerCase(),syllables.map(x=>x[0]||'').join('').toLowerCase()];if(phonetic.size>50000)phonetic.clear();phonetic.set(text,value);return value;}
function matches(value,query,enabled=true){if(value.toLocaleLowerCase().includes(query))return true;if(!enabled||!/[a-z]/i.test(query)||/[^\x00-\x7f]/.test(query)||!/[\u3400-\u9fff]/.test(value))return false;const q=query.replace(/[^a-z0-9]/gi,'');return q&&folded(value).some(x=>x.includes(q));}
function fuzzy(value,query){const a=[...value.toLocaleLowerCase()],b=[...query.toLocaleLowerCase()];if(b.length<3||b.length>32||Math.abs(a.length-b.length)>2)return false;let previous=Array.from({length:b.length+1},(_,i)=>i);for(let i=0;i<a.length;i++){const current=[i+1];for(let j=0;j<b.length;j++)current[j+1]=Math.min(current[j]+1,previous[j+1]+1,previous[j]+(a[i]===b[j]?0:1));if(Math.min(...current)>2)return false;previous=current;}return previous[b.length]<=Math.min(2,Math.floor(b.length/4)+1);}
function calculate(input){
 if(input.length>1024)return null;let s=input.toLowerCase().replaceAll('×','*').replaceAll('÷','/'),i=0,depth=0;
 const eat=t=>{while(/\s/.test(s[i]||'')&&i<s.length)i++;if(s.slice(i,i+t.length)===t){i+=t.length;return true;}return false;};
 const fn={sqrt:Math.sqrt,sin:Math.sin,cos:Math.cos,tan:Math.tan,sind:x=>Math.sin(x*Math.PI/180),cosd:x=>Math.cos(x*Math.PI/180),tand:x=>Math.tan(x*Math.PI/180),abs:Math.abs,ln:Math.log,log:Math.log10};
 function primary(){if(++depth>100)throw Error();let v;if(eat('(')){v=or();if(!eat(')'))throw Error();}else{eat('');const n=/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/.exec(s.slice(i));if(n){i+=n[0].length;v=Number(n[0]);}else{const name=/^[a-zπ]+/.exec(s.slice(i));if(!name)throw Error();i+=name[0].length;if(name[0]==='pi'||name[0]==='π')v=Math.PI;else if(name[0]==='e')v=Math.E;else{if(!fn[name[0]]||!eat('('))throw Error();const arg=or();if(!eat(')'))throw Error();v=fn[name[0]](arg);}}}depth--;return v;}
 function power(){const n=primary();return eat('^')?n**unary():n;}
 function unary(){if(eat('+'))return unary();if(eat('-'))return -unary();if(eat('√'))return Math.sqrt(unary());return power();}
 function term(){let n=unary();while(true){if(eat('*'))n*=unary();else if(eat('/'))n/=unary();else if(eat('%'))n%=unary();else return n;}}
 function add(){let n=term();while(true){if(eat('+'))n+=term();else if(eat('-'))n-=term();else return n;}}
 function shift(){let n=add();while(true){const op=eat('>>>')?'>>>':eat('>>')?'>>':eat('<<')?'<<':null;if(!op)return n;const r=add();if(!Number.isInteger(n)||!Number.isInteger(r)||r<0||r>31)throw Error();n=op==='>>>'?n>>>r:op==='>>'?n>>r:n<<r;}}
 function and(){let n=shift();while(eat('&'))n=n&shift();return n;}function xor(){let n=and();while(eat('xor'))n=n^and();return n;}function or(){let n=xor();while(eat('|'))n=n|xor();return n;}
 try{const result=or();eat('');return i===s.length&&Number.isFinite(result)?Number(result.toPrecision(14)):null;}catch{return null;}
}
function zoneDate(date,zone,onlyDate=false){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value]));return `${p.year}-${p.month}-${p.day}`+(onlyDate?'':` ${p.hour}:${p.minute}:${p.second}`);}
function timeResults(query,now=new Date()){
 const q=query.trim(),lower=q.toLowerCase();let date;
 if(['时间','sj','time','时间戳','日期','rq','date'].includes(lower))date=now;
 else {const match=/^(\d{10}|\d{13}|\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?)(.*)$/.exec(q);if(!match)return [];const base=match[1],parts=match[2].trim().split(/\s+/).filter(Boolean);let offset=8;if(/^[+-]\d{1,2}$/.test(parts[0]||'')){offset=Number(parts.shift());if(offset< -12||offset>14)return [];}
 if(/^\d+$/.test(base))date=new Date(Number(base)*(base.length===10?1000:1));else{const normalized=base.replace('T',' ');const pieces=normalized.split(/[- :]/).map(Number),[y,m,d,h=0,mi=0,se=0]=pieces;date=new Date(Date.UTC(y,m-1,d,h-offset,mi,se));const shifted=new Date(date.getTime()+offset*3600000);if(shifted.getUTCFullYear()!==y||shifted.getUTCMonth()!==m-1||shifted.getUTCDate()!==d||h>23||mi>59||se>59)return [];}
 for(const token of parts){const m=/^([+-]\d+)([hdymsMf])$/.exec(token);if(!m||Math.abs(Number(m[1]))>100000)return [];const amount=Number(m[1]);if(m[2]==='m'||m[2]==='y'){const shifted=new Date(date.getTime()+offset*3600000),day=shifted.getUTCDate();shifted.setUTCDate(1);if(m[2]==='m')shifted.setUTCMonth(shifted.getUTCMonth()+amount);else shifted.setUTCFullYear(shifted.getUTCFullYear()+amount);const limit=new Date(Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth()+1,0)).getUTCDate();shifted.setUTCDate(Math.min(day,limit));date=new Date(shifted.getTime()-offset*3600000);}else date=new Date(date.getTime()+amount*({s:1000,M:60000,f:60000,h:3600000,d:86400000}[m[2]]));}}
 if(!Number.isFinite(date?.getTime())||date.getTime()<0||date.getTime()>=4102444800000)return [];
 if(['日期','rq','date'].includes(lower))return [{value:zoneDate(date,'Asia/Shanghai',true),label:'中国日期'},{value:zoneDate(date,'America/Los_Angeles',true),label:'美西日期'}];
 const values=[{value:String(Math.floor(date.getTime()/1000)),label:'Unix 秒时间戳'},{value:String(date.getTime()),label:'Unix 毫秒时间戳'},{value:zoneDate(date,'Asia/Shanghai'),label:'中国时间 · UTC+8'},{value:zoneDate(date,'America/Los_Angeles'),label:'美西时间 · 洛杉矶'}];if(['时间','sj','time','时间戳'].includes(lower))values.push({value:zoneDate(date,'Asia/Shanghai').slice(11),label:'中国时分秒'});return values;
}
const identity=item=>crypto.createHash('sha256').update((item.type||item.kind)+':'+item.value).digest('hex');
function rankResults(list,q,ranking={usage:{},rules:{}}){const now=Date.now();return list.map(item=>{const key=identity(item),rule=ranking.rules?.[key],usage=ranking.usage?.[key];const days=usage?(now-usage.lastUsed)/86400000:Infinity;const bonus=usage?Math.min(42,Math.log2(usage.count+1)*11)+(days<1?18:days<7?12:days<30?6:0):0;const title=item.title.toLowerCase();return {item,hidden:rule?.hidden,score:(item.rank||0)+(title===q?30:0)+(title.startsWith(q)?10:0)+bonus+(rule?.pinned?1000:0)};}).filter(x=>!x.hidden).sort((a,b)=>b.score-a.score||a.item.title.localeCompare(b.item.title,'zh-CN',{numeric:true})).slice(0,80).map(x=>x.item);}
function search(query,data,settings,ranking,snippets=[]){
 const entered=String(query).trim(),exact=entered.startsWith('='),original=(exact?entered.slice(1):entered).trim(),q=original.toLowerCase(),pin=settings.pinyinEnabled!==false;
 const names=c=>[c.title,...c.keywords,...(settings.commandAliases[c.id]||[])];
 if(!q)return [];
 if(q.startsWith('?')||q.startsWith('？')){const term=q.slice(1).trim();return commands.filter(c=>!term||names(c).some(n=>exact?n.toLowerCase()===term:matches(n,term,pin))||!exact&&c.detail.includes(term)).sort((a,b)=>(settings.commandFavorites||[]).includes(b.id)-(settings.commandFavorites||[]).includes(a.id)||a.title.localeCompare(b.title,'zh-CN')).map(x=>({...x,detail:x.detail+' · '+x.keywords.join(' / ')}));}
 const request=fileRequest(original,commands.flatMap(names));
 if(request)return settings.searchFiles?rankResults(data.files.filter(x=>matchesFile(x,request)&&(exact?x.title.toLowerCase()===request.term.toLowerCase():matches(x.title,request.term.toLowerCase(),pin))),q,ranking):[];
 if(q.startsWith('翻译')||q.startsWith('translate ')){const value=original.replace(/^(翻译|translate)\s*/i,'');return [{type:'tool',id:'translate',title:'在有道翻译中打开',detail:value||'打开翻译窗口',value:'translate',initialValue:value,symbol:'translate',rank:110}];}
 const times=timeResults(original);if(times.length)return times.map(x=>({type:'text',title:x.value,detail:x.label+' · 回车复制',value:x.value,symbol:'clock',rank:115}));
 const expression=q.replace(/^calc\s+/,''),calc=calculate(expression);if(calc!==null&&(/[\dπ]/.test(expression)&&/[+\-*/×÷()%√^&|<>]/.test(expression)||/^(?:calc |sqrt\(|cos\(|sin\(|tan\(|ln\(|log\()/.test(q)))return [{type:'text',title:String(calc),detail:'计算结果 · 回车复制',value:String(calc),symbol:'equal',rank:110}];
 if(q.startsWith(';'))return snippets.filter(x=>matches(x.name,q.slice(1),pin)||x.keyword.includes(q.slice(1))).map(x=>({type:'snippet',title:x.name,detail:';'+x.keyword+' · '+x.body.slice(0,100),value:x.id,symbol:'text',rank:120}));
 const direct=[['comparison',/^(?:文本对比|diff)\s+([\s\S]+)$/i],['unicode',/^(?:unicode转中文|中文转unicode|unicode)\s+([\s\S]+)$/i],['markdown',/^(?:mark|markdown)\s+([\s\S]+)$/i],['json',/^json格式化\s+([\s\S]+)$/i]].find(([,pattern])=>pattern.test(original));if(direct&&!exact){const item=commands.find(x=>x.id===direct[0]);return rankResults([{...item,initialValue:direct[1].exec(original)[1]}],q,ranking);}
 let list=[];for(const c of commands){if(names(c).some(n=>exact?n.toLowerCase()===q:matches(n,q,pin))||!exact&&c.detail.toLowerCase().includes(q))list.push({...c});}
 const scope=['应用 ','书签 ','历史 '].find(x=>q.startsWith(x)),filter=scope?q.slice(scope.length).trim():q;
 if(!scope||scope==='应用 ')list.push(...data.apps.filter(x=>exact?x.title.toLowerCase()===filter:matches(x.title,filter,pin)));
 if(settings.chromeBookmarks&&(!scope||scope==='书签 '))list.push(...data.bookmarks.filter(x=>exact?x.title.toLowerCase()===filter:matches(x.title,filter,pin)||filter.length>=2&&x.value.toLowerCase().includes(filter)));
 if(!exact&&!scope){for(const a of settings.aliases||[]){const key=(a.keywords||[]).find(n=>q===n.toLowerCase()||q.startsWith(n.toLowerCase()+' ')&&a.url.includes('{query}'));if(key)list.push({type:'url',title:a.name,detail:original.slice(key.length).trim()?'搜索“'+original.slice(key.length).trim()+'”':'打开网站',value:a.url.replaceAll('{query}',encodeURIComponent(original.slice(key.length).trim())),rank:105,symbol:'link'});}}
 if(settings.searchFiles&&!scope&&filter.length>=2)list.push(...data.files.filter(x=>exact?x.title.toLowerCase()===filter:matches(x.title,filter,pin)).slice(0,50));
 if(settings.chromeHistory&&(!scope||scope==='历史 '))list.push(...(data.history||[]).filter(x=>exact?x.title.toLowerCase()===filter:matches(x.title,filter,pin)||x.value.toLowerCase().includes(filter)));
 if(!exact&&!list.length&&q.length>=3){for(const item of [...data.apps,...commands,...(settings.chromeBookmarks?data.bookmarks:[])])if(fuzzy(item.title,q)||(item.keywords||[]).some(n=>fuzzy(n,q)))list.push({...item,detail:'可能想找：'+item.detail,rank:10});}
 return rankResults(list,q,ranking);
}
module.exports={documents,images,commands,fileRequest,matchesFile,matches,fuzzy,calculate,timeResults,rankResults,search,identity};
