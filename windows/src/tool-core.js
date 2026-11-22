(function (scope) {
  'use strict';
  const hex = n => n.toString(16).toUpperCase().padStart(4, '0');
  function unicodeEncode(text) {
    let result = '';
    for (const character of String(text)) {
      const code = character.codePointAt(0);
      if (character === '\\') result += '\\\\';
      else if ('\n\r\t\b\f'.includes(character)) result += ({'\n':'\\n','\r':'\\r','\t':'\\t','\b':'\\b','\f':'\\f'})[character];
      else if (code >= 32 && code <= 126) result += character;
      else if (code <= 65535) result += '\\u' + hex(code);
      else { const value=code-65536; result += '\\u'+hex(0xD800+(value>>10))+'\\u'+hex(0xDC00+(value&1023)); }
    }
    return result;
  }
  function unicodeDecode(text) {
    text=String(text); let output='',i=0;
    const invalid=(position,message)=>{throw Error(`第 ${position+1} 个字符：${message}`);};
    const four=position=>{const digits=text.slice(i,i+4);if(!/^[\da-f]{4}$/i.test(digits))invalid(position,'\\u 后需要四位十六进制数字');i+=4;return parseInt(digits,16);};
    while(i<text.length) {
      const start=i, character=text[i++]; if(character!=='\\'){output+=character;continue;}
      if(i===text.length)invalid(start,'反斜杠后缺少转义字符');
      const next=text[i++];
      if(next!=='u'){output+=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f','\\':'\\','"':'"','/':'/'})[next]??'\\'+next;continue;}
      let value;
      if(text[i]==='{'){const match=text.slice(i).match(/^\{([\da-f]{1,6})\}/i);if(!match)invalid(start,'\\u{...} 需要 1–6 位十六进制数字和右花括号');value=parseInt(match[1],16);i+=match[0].length;}
      else value=four(start);
      if(value>=0xD800&&value<=0xDBFF){if(text.slice(i,i+2)!=='\\u')invalid(start,'高位代理项后缺少低位代理项');i+=2;const low=four(start);if(low<0xDC00||low>0xDFFF)invalid(start,'低位代理项无效');value=65536+(value-0xD800)*1024+(low-0xDC00);}
      if(value>0x10FFFF||(value>=0xDC00&&value<=0xDFFF))invalid(start,'Unicode 码点无效');
      output+=String.fromCodePoint(value);
    }
    return output;
  }
  const durationUnits=[['年 · 365 天','yr',31536000],['月 · 30 天','mo',2592000],['周','week',604800],['天','d',86400],['小时','h',3600],['分钟','min',60],['秒','s',1],['毫秒','ms',0.001],['微秒','μs',0.000001],['纳秒','ns',0.000000001]];
  function durationRows(value,source=6){if(!Number.isFinite(Number(value))||!durationUnits[source])return [];return durationUnits.map(([name,symbol,seconds])=>{const result=Number(value)*durationUnits[source][2]/seconds;return {title:`${name} (${symbol})`,value:!Number.isFinite(result)?'超出范围':Math.abs(result)>=1&&Math.abs(result)<1e15&&Math.abs(result-Math.round(result))<=Math.abs(result)*1e-12?String(Math.round(result)):Number(result.toPrecision(9)).toString()};});}
  const controlNames=['NUL','SOH','STX','ETX','EOT','ENQ','ACK','BEL','BS','TAB','LF','VT','FF','CR','SO','SI','DLE','DC1','DC2','DC3','DC4','NAK','SYN','ETB','CAN','EM','SUB','ESC','FS','GS','RS','US'];
  function asciiRows(query='',category='all'){const term=query.trim().toLowerCase();return Array.from({length:128},(_,number)=>({number,hex:'0x'+number.toString(16).toUpperCase().padStart(2,'0'),character:number<32?controlNames[number]:number===32?'空格':number===127?'DEL':String.fromCharCode(number),name:number<32||number===127?'控制字符':number===32?'空格':'可打印字符'})).filter(row=>(category==='all'||category==='control'&&(row.number<32||row.number===127)||category==='printable'&&row.number>=32&&row.number<127)&&(!term||Object.values(row).join(' ').toLowerCase().includes(term)));}
  function cronParse(text){
    const fields=String(text).trim().split(/\s+/);if(fields.length!==5)throw Error('表达式应为 5 个字段：分 时 日 月 周');
    const bounds=[[0,59],[0,23],[1,31],[1,12],[0,7]],names=[{}, {}, {}, {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12},{sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}];
    const sets=fields.map((field,index)=>{const [low,high]=bounds[index],found=new Set();const number=x=>Object.hasOwn(names[index],x)?names[index][x]:/^\d+$/.test(x)?Number(x):NaN;
      for(const segment of field.toLowerCase().split(',')){const split=segment.split('/');if(split.length>2)throw Error('Cron 步长格式无效');const step=split.length===2?number(split[1]):1;if(!Number.isInteger(step)||step<=0)throw Error('Cron 步长必须为正整数');let a,b;
        if(split[0]==='*'){a=low;b=high;}else if(split[0].includes('-')){const range=split[0].split('-');if(range.length!==2)throw Error('Cron 范围无效');a=number(range[0]);b=number(range[1]);}else{a=number(split[0]);b=split.length===2?high:a;}
        if(!Number.isInteger(a)||!Number.isInteger(b)||a<low||b>high||a>b)throw Error(`Cron 第 ${index+1} 个字段超出范围 ${low}–${high}`);
        for(let value=a;value<=b;value+=step)found.add(index===4&&value===7?0:value);
      }return found;});
    return {fields,sets,anyDay:fields[2]==='*',anyWeekday:fields[4]==='*'};
  }
  function cronNext(expression,after=new Date(),count=5){
    const parsed=typeof expression==='string'?cronParse(expression):expression, result=[];
    const [minutes,hours,days,months,weekdays]=parsed.sets;
    // 与 macOS 一致按中国时区计算，逐日跳跃，避免遍历五年的每一分钟。
    const shifted=new Date(+after+8*3600000),start=Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate());
    for(let offset=0;offset<366*5+2;offset++){const day=new Date(start+offset*86400000);if(!months.has(day.getUTCMonth()+1))continue;const dm=days.has(day.getUTCDate()),wm=weekdays.has(day.getUTCDay());if(!(parsed.anyDay&&parsed.anyWeekday||parsed.anyDay&&wm||parsed.anyWeekday&&dm||!parsed.anyDay&&!parsed.anyWeekday&&(dm||wm)))continue;
      for(const hour of [...hours].sort((a,b)=>a-b))for(const minute of [...minutes].sort((a,b)=>a-b)){const value=+day+hour*3600000+minute*60000-8*3600000;if(value>+after){result.push(new Date(value));if(result.length>=count)return result;}}
    }return result;
  }
  function cronSummary(expression) {
    const parsed = typeof expression === 'string' ? cronParse(expression) : expression;
    const [minutes, hours, days, months, weekdays] = parsed.sets;
    const sorted = values => [...values].sort((a, b) => a - b);
    function range(values) {
      const numbers = sorted(values);
      const first = numbers[0], last = numbers.at(-1);
      if (numbers.length > 2 && last - first + 1 === numbers.length) return `${first}–${last}`;
      return numbers.join('、');
    }
    const names = ['周日','周一','周二','周三','周四','周五','周六'];
    const week = weekdays.size === 5 && !weekdays.has(0) && !weekdays.has(6)
      ? '周一至周五' : sorted(weekdays).map(day => names[day]).join('、');
    const date = `每月 ${range(days)} 日`;
    const dayRule = parsed.anyDay ? (parsed.anyWeekday ? '每天' : week)
      : (parsed.anyWeekday ? date : `${date} 或 ${week}`);
    const ticks = sorted(minutes);
    const step = ticks[1];
    let minuteRule = `第 ${range(minutes)} 分钟执行`;
    if (ticks.length === 60) minuteRule = '每分钟';
    else if (ticks.length === 1 && ticks[0] === 0) minuteRule = '整点执行';
    else if (ticks.length > 2 && ticks.length === Math.ceil(60 / step)
      && ticks.every((v, i) => v === i * step)) minuteRule = `每 ${step} 分钟`;
    return [months.size === 12 ? '' : `${range(months)} 月`, dayRule,
      hours.size === 24 ? '全天' : `${range(hours)} 时`, minuteRule].filter(Boolean).join(' · ');
  }
  const idWeights=[7,9,10,5,8,4,2,1,6,3,7,9,10,5,8,4,2],idChecks='10X98765432';
  const regionData=typeof module!=='undefined'&&module.exports?require('../assets/id-regions.js'):scope.OpenAllIDRegions;
  let provinces=regionData.provinces.map(province=>({...province,regions:province.cities.flatMap(city=>city.regions)}));
  function idChecksum(prefix){if(!/^\d{17}$/.test(prefix))throw Error('身份证前 17 位需为数字');return idChecks[[...prefix].reduce((sum,n,i)=>sum+Number(n)*idWeights[i],0)%11];}
  function idValid(number){if(!/^\d{17}[\dX]$/i.test(number))return false;const y=Number(number.slice(6,10)),m=Number(number.slice(10,12)),d=Number(number.slice(12,14));const date=new Date(Date.UTC(y,m-1,d));return date.getUTCFullYear()===y&&date.getUTCMonth()===m-1&&date.getUTCDate()===d&&idChecksum(number.slice(0,17))===number.slice(-1).toUpperCase();}
  function randomInt(max){const data=new Uint32Array(1);const limit=Math.floor(0x100000000/max)*max;do {if(scope.crypto?.getRandomValues)scope.crypto.getRandomValues(data);else data[0]=Math.floor(Math.random()*0x100000000);}while(data[0]>=limit);return data[0]%max;}
  function birthdayFromAge(age,referenceDate=new Date()){
    if(!(referenceDate instanceof Date)||!Number.isFinite(referenceDate.getTime()))throw Error('参考日期无效');
    const maximum=referenceDate.getFullYear()-1900;
    if(!Number.isInteger(age)||age<0||age>maximum)throw Error(`年龄需为 0–${maximum} 的整数`);
    const year=referenceDate.getFullYear()-age,month=referenceDate.getMonth()+1;
    // 反推结果保留当地日历月日；非闰年的 2 月 29 日取该月最后一天。
    const day=Math.min(referenceDate.getDate(),new Date(year,month,0).getDate());
    return {year,month,day,clamped:day!==referenceDate.getDate()};
  }
  function generateIDs(options={}){
    const count=options.count??1;if(!Number.isInteger(count)||count<1||count>500)throw Error('生成数量需为 1–500');
    for(const key of ['provinceIndex','cityIndex','regionIndex'])if(options[key]!=null&&(!Number.isInteger(options[key])||options[key]<0))throw Error('请选择有效地区');
    if(options.provinceIndex==null&&(options.cityIndex!=null||options.regionIndex!=null))throw Error('请先选择省份');
    const selected=options.provinceIndex==null?provinces:provinces[options.provinceIndex]?[provinces[options.provinceIndex]]:[];
    const regions=selected.flatMap(province=>{
      const candidates=options.cityIndex==null?province.regions:province.cities[options.cityIndex]?.regions||[];
      return options.regionIndex==null?candidates:candidates[options.regionIndex]?[candidates[options.regionIndex]]:[];
    });if(!regions.length)throw Error('请选择有效地区');
    for(const [key,low,high] of [['year',1900,2100],['month',1,12],['day',1,31]])if(options[key]!=null&&(!Number.isInteger(options[key])||options[key]<low||options[key]>high))throw Error('请检查出生日期');
    const birthdays=[];for(let year=options.year??1960;year<=(options.year??2005);year++)for(let month=options.month??1;month<=(options.month??12);month++){const end=new Date(Date.UTC(year,month,0)).getUTCDate();for(let day=options.day??1;day<=(options.day??end);day++)if(day<=end)birthdays.push(String(year)+String(month).padStart(2,'0')+String(day).padStart(2,'0'));}
    if(!birthdays.length)throw Error('日期需真实存在');const result=new Set();for(let attempt=0;attempt<100000&&result.size<count;attempt++){const seq=options.gender==='男'?randomInt(500)*2+1:options.gender==='女'?randomInt(500)*2:randomInt(999)+1;const prefix=regions[randomInt(regions.length)].code+birthdays[randomInt(birthdays.length)]+String(seq).padStart(3,'0');result.add(prefix+idChecksum(prefix));}if(result.size!==count)throw Error('当前条件下可生成的唯一号码不足');return [...result];
  }
  function crc32(bytes){let crc=0xFFFFFFFF;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xEDB88320:0);}return (crc^0xFFFFFFFF)>>>0;}
  function paddedPNG(bytes,target){const input=bytes instanceof Uint8Array?bytes:new Uint8Array(bytes),signature=[137,80,78,71,13,10,26,10];if(!signature.every((v,i)=>input[i]===v)||!Number.isInteger(target)||target<input.length||target>100000000)throw Error('目标体积须大于当前 PNG 文件，且不超过 100 MB');if(target===input.length)return input;if(target-input.length<27)throw Error('目标体积至少应比当前 PNG 增加 27 字节');const view=new DataView(input.buffer,input.byteOffset,input.byteLength);for(let offset=8;offset+12<=input.length;){const length=view.getUint32(offset);if(length>input.length-offset-12)break;if(String.fromCharCode(...input.subarray(offset+4,offset+8))==='IEND'){const result=new Uint8Array(target),diff=target-input.length,payload=diff-12;result.set(input.subarray(0,offset));const out=new DataView(result.buffer);out.setUint32(offset,payload);result.set(new TextEncoder().encode('opAdOpenAllPadding\0'),offset+4);out.setUint32(offset+8+payload,crc32(result.subarray(offset+4,offset+8+payload)));result.set(input.subarray(offset),offset+diff);return result;}offset+=length+12;}throw Error('PNG 文件结构无效');}
  function findText(text,query,caseSensitive=false){const matches=[];let total=0;if(!query)return {matches,total};const escaped=String(query).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),pattern=new RegExp(escaped,caseSensitive?'g':'gi');for(const match of String(text).matchAll(pattern)){total++;if(matches.length<5000)matches.push({from:match.index,to:match.index+match[0].length});}return {matches,total};}
  function durationDisplay(raw){const value=Number(raw);if(!Number.isFinite(value))return raw;let display=Number(value.toPrecision(6)).toString();if(value!==0&&(Math.abs(value)<0.0001||Math.abs(value)>=1000000))display=value.toExponential(5).replace(/\.?0+e/,'e');const parts=display.split('e');return parts.length===2?parts[0]+' × 10'+String(Number(parts[1])).split('').map(x=>({'-':'⁻','0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹'})[x]||x).join(''):display;}
  function asciiDescription(number){const punctuation={32:'空格',33:'感叹号',34:'双引号',35:'井号',36:'美元符号',37:'百分号',38:'与号',39:'单引号',40:'左圆括号',41:'右圆括号',42:'星号',43:'加号',44:'逗号',45:'连字符',46:'句点',47:'斜杠',58:'冒号',59:'分号',60:'小于号',61:'等号',62:'大于号',63:'问号',64:'At 符号',91:'左方括号',92:'反斜杠',93:'右方括号',94:'脱字符',95:'下划线',96:'反引号',123:'左花括号',124:'竖线',125:'右花括号',126:'波浪号'};return punctuation[number]||(number>=48&&number<=57?'数字':number>=65&&number<=90?'大写字母':number>=97&&number<=122?'小写字母':'控制字符');}
  const api={findText,durationDisplay,asciiDescription,unicodeEncode,unicodeDecode,durationUnits,durationRows,asciiRows,cronParse,cronNext,cronSummary,idChecksum,idValid,birthdayFromAge,generateIDs,paddedPNG,crc32,get provinces(){return provinces;},setProvinces(value){provinces=value;}};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else scope.OpenAllTools=api;
})(typeof window!=='undefined'?window:globalThis);
