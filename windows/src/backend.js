'use strict';
const YAML = require('yaml');
const MAX_TEXT=32*1024*1024;
function bounded(text){if(typeof text!=='string'||text.length>MAX_TEXT)throw Error('单次内容请控制在 32 MB 以内');return text;}
function parseConfig(text,format='auto') {
  bounded(text);if(!text.trim())throw Error('请输入配置内容');
  if(format==='auto'){const clean=text.trim();format=/^[{[]/.test(clean)?'json':clean.split(/\r?\n/).filter(x=>x.trim()&&!/^[#!]/.test(x.trim())).every(x=>/^.*?[^\\]=/.test(x))?'properties':'yaml';}
  if(format==='json')return JSON.parse(text);
  if(format==='yaml')return YAML.parse(text,{uniqueKeys:true,maxAliasCount:100});
  if(format!=='properties')throw Error('请选择 JSON、YAML 或 Properties');
  const obj=Object.create(null);let continuation='';
  const decode=value=>value.replace(/\\u([\da-f]{4})|\\(.)/gi,(_m,hex,character)=>hex?String.fromCharCode(parseInt(hex,16)):({t:'\t',n:'\n',r:'\r',f:'\f'})[character]??character);
  for(const [index,raw] of text.split(/\r?\n/).entries()){
    let line=continuation+raw.replace(/^[ \t\f]+/,'');continuation='';if(!line||/^[#!]/.test(line))continue;
    const slashes=line.match(/\\+$/)?.[0].length??0;if(slashes%2){continuation=line.slice(0,-1);continue;}
    let end=0;for(;end<line.length;end++){if(line[end]==='\\'){end++;continue;}if(/[:=\s]/.test(line[end]))break;}
    const key=decode(line.slice(0,end));if(!key)throw Error(`第 ${index+1} 行的键为空`);
    let value=line.slice(end).replace(/^\s*[:=]?\s*/,'');obj[key]=decode(value);
  }
  if(continuation)throw Error('Properties 续行缺少下一行');return obj;
}
function flatten(value){
  const result=new Map(),ancestors=new WeakSet(),stack=[{value,path:'$',depth:0}];
  while(stack.length){const item=stack.pop(),v=item.value;if(item.exit){ancestors.delete(v);continue;}if(item.depth>256||result.size>200000)throw Error('配置层级或字段数量过大');
    if(v!==null&&typeof v==='object'){if(ancestors.has(v))throw Error('配置包含循环引用');const entries=Object.entries(v);if(entries.length){ancestors.add(v);stack.push({value:v,exit:true});for(let i=entries.length-1;i>=0;i--){const [key,child]=entries[i];const p=Array.isArray(v)?`${item.path}[${key}]`:item.path==='$'?key:`${item.path}.${key}`;stack.push({value:child,path:p,depth:item.depth+1});}continue;}}
    result.set(item.path,v);
  }return result;
}
function configDiff(left,right,format='auto',reveal=false){
  const a=flatten(parseConfig(left,format)),b=flatten(parseConfig(right,format));
  const type=v=>v===null?'null':Array.isArray(v)?'array':typeof v;
  return [...new Set([...a.keys(),...b.keys()])].sort((x,y)=>x.localeCompare(y,undefined,{numeric:true})).flatMap(key=>{const av=a.get(key),bv=b.get(key),status=!a.has(key)?'新增':!b.has(key)?'删除':JSON.stringify(av)!==JSON.stringify(bv)?'变化':null;if(!status)return [];const sensitive=/pass(word|wd)?|secret|token|credential|authorization|api.?key|private.?key|私钥|密码/i.test(key);const view=v=>sensitive&&!reveal?'••••••':typeof v==='string'?v:JSON.stringify(v)??'—';return [{key,status,left:a.has(key)?view(av):'—',right:b.has(key)?view(bv):'—',leftType:a.has(key)?type(av):'',rightType:b.has(key)?type(bv):''}];});
}
function parseLogs(text,rule=''){
  bounded(text);let custom=null,field='';if(rule.trim()){const equal=rule.indexOf('=');if(equal<1)throw Error('手动规则格式：字段名=正则表达式，使用第 1 个捕获组');field=rule.slice(0,equal).trim();const pattern=rule.slice(equal+1);if(pattern.length>512)throw Error('正则表达式过长');custom=new RegExp(pattern);if(!/\((?!\?:|\?=|\?!)/.test(pattern))throw Error('正则表达式需要至少一个捕获组');}
  const result=[];for(const [position,raw] of text.split(/\r?\n/).slice(0,10000).entries()){if(!raw.trim())continue;let fields=Object.create(null);try{const value=JSON.parse(raw);if(value&&typeof value==='object'&&!Array.isArray(value)){for(const [key,v] of Object.entries(value)){if(v&&typeof v==='object'&&!Array.isArray(v)){for(const [child,nested] of Object.entries(v))fields[`${key}.${child}`]=typeof nested==='object'?JSON.stringify(nested):String(nested);}else fields[key]=typeof v==='object'?JSON.stringify(v):String(v);}}}catch{}
    if(!Object.keys(fields).length){const pattern=/(?:^|[\s,])([A-Za-z_][\w.-]*)=("(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\s,]+)/g;for(const match of raw.matchAll(pattern)){let value=match[2];if(value.startsWith('"')){try{value=JSON.parse(value);}catch{value=value.slice(1,-1);}}else if(value.startsWith("'"))value=value.slice(1,-1);fields[match[1]]=value;}const time=raw.match(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/);if(time)fields['时间']=time[0];}
    if(custom){const match=custom.exec(raw);if(match?.[1]!==undefined)fields[field]=match[1];}result.push({raw,fields,position});
  }return result;
}
function logFields(rows){const counts=new Map();for(const row of rows)for(const [key,value] of Object.entries(row.fields)){if(value==='')continue;const entry=counts.get(key)||{key,count:0,sample:String(value)};entry.count++;counts.set(key,entry);}return [...counts.values()].sort((a,b)=>b.count-a.count||a.key.localeCompare(b.key));}
function timeNumber(value){if(/^\d{10}(?:\d{3})?$/.test(String(value)))return Number(value)*(String(value).length===10?1000:1);return Date.parse(value);}
function logGroups(rows,field,timeField){const groups=new Map();for(const row of rows){const key=String(row.fields[field]??'（未识别）'),group=groups.get(key)||[];group.push(row);groups.set(key,group);}return [...groups].map(([name,entries])=>({name,entries:entries.slice().sort((a,b)=>{const av=timeNumber(a.fields[timeField]),bv=timeNumber(b.fields[timeField]);return Number.isFinite(av)&&Number.isFinite(bv)&&av!==bv?av-bv:(a.position??0)-(b.position??0);})})).sort((a,b)=>b.entries.length-a.entries.length||a.name.localeCompare(b.name));}
class NumericLiteral{constructor(value){this.value=value;}}
function sqlLiteral(value){if(value instanceof NumericLiteral)return value.value;if(value===null)return 'NULL';if(typeof value==='number'&&Number.isFinite(value))return String(value);if(typeof value==='boolean')return value?'TRUE':'FALSE';if(typeof value!=='string')throw Error('参数只能是字符串、数字、布尔值或 null');return "'"+value.replace(/'/g,"''")+"'";}
function parseParameters(text){
  if(Array.isArray(text)||text&&typeof text==='object')return text;
  bounded(text);const clean=text.trim().replace(/^(?:==>\s*)?Parameters:\s*/i,'');try{return JSON.parse(clean);}catch{}
  let quote='',depth=0,part='',fragments=[];for(let i=0;i<clean.length;i++){const c=clean[i];if(quote){part+=c;if(c==='\\'&&i+1<clean.length)part+=clean[++i];else if(c===quote)quote='';continue;}if(c==='"'||c==="'")quote=c;if(c==='(')depth++;if(c===')')depth--;if(c===','&&depth===0){fragments.push(part);part='';}else part+=c;}fragments.push(part);
  const positional=[],named=Object.create(null);let usesNamed=false;
  const convert=(raw,type)=>{raw=raw.trim();if(/^null$/i.test(raw))return null;if(/^(true|false)$/i.test(raw))return raw.toLowerCase()==='true';if((!type||/int|long|short|double|float|decimal|number/i.test(type))&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw))return new NumericLiteral(raw);if((raw.startsWith("'")&&raw.endsWith("'"))||(raw.startsWith('"')&&raw.endsWith('"')))return raw.slice(1,-1);return raw;};
  for(const raw of fragments){const fragment=raw.trim();if(!fragment)continue;const namedMatch=fragment.match(/^([A-Za-z_]\w*)\s*=\s*([\s\S]*)$/);if(namedMatch){usesNamed=true;named[namedMatch[1]]=convert(namedMatch[2]);}else{const typed=fragment.match(/^([\s\S]*?)\((\w+)\)$/);positional.push(convert(typed?typed[1]:fragment,typed?.[2]));}}
  if(usesNamed&&positional.length)throw Error('请分别使用命名参数或顺序参数');return usesNamed?named:positional;
}
function restoreSQL(sql,parameters){
  bounded(sql);const params=parseParameters(parameters);if(!Array.isArray(params)&&(!params||typeof params!=='object'))throw Error('参数需为 JSON 数组、对象或参数日志');
  sql=sql.replace(/^(?:==>\s*)?Preparing:\s*/i,'');let output='',index=0,state='normal',depth=0,dollar='',used=new Set(),missing=[],replacementRanges=[];
  for(let i=0;i<sql.length;i++){const ch=sql[i],next=sql[i+1];if(state==='line'){output+=ch;if(ch==='\n')state='normal';continue;}
    if(state==='block'){output+=ch;if(ch==='/'&&next==='*'){output+=next;i++;depth++;}else if(ch==='*'&&next==='/'){output+=next;i++;if(--depth===0)state='normal';}continue;}
    if(state==='dollar'){if(sql.startsWith(dollar,i)){output+=dollar;i+=dollar.length-1;state='normal';}else output+=ch;continue;}
    if(state!=='normal'){output+=ch;if(ch==='\\'&&i+1<sql.length){output+=sql[++i];continue;}if(ch===state){if(next===state){output+=next;i++;}else state='normal';}continue;}
    if((ch==='-'&&next==='-')||ch==='#'){output+=ch;if(ch==='-')output+=sql[++i];state='line';continue;}
    if(ch==='/'&&next==='*'){output+=ch+next;i++;state='block';depth=1;continue;}
    if(ch==="'"||ch==='"'||ch==='`'){state=ch;output+=ch;continue;}
    if(ch==='$'){const tag=sql.slice(i).match(/^\$(?:[A-Za-z_]\w*)?\$/);if(tag){dollar=tag[0];output+=dollar;i+=dollar.length-1;state='dollar';continue;}}
    let name,token;if(ch==='?'){name=String(index++);token='?';}else if(ch==='$'&&/[1-9]/.test(next||'')){const match=sql.slice(i).match(/^\$([1-9]\d*)/);token=match[0];name=String(Number(match[1])-1);i+=token.length-1;}else if(ch===':'&&sql[i-1]!==':'&&/[A-Za-z_]/.test(next||'')){const match=sql.slice(i).match(/^:([A-Za-z_]\w*)/);token=match[0];name=match[1];i+=token.length-1;}
    if(token){if(Object.hasOwn(params,name)){const from=output.length;output+=sqlLiteral(params[name]);replacementRanges.push({from,to:output.length});used.add(name);}else{output+=token;missing.push(token);}continue;}output+=ch;
  }return {sql:output,missing,unused:Object.keys(params).filter(x=>!used.has(x)),replacementRanges,replaced:replacementRanges.length,unresolved:missing.length};
}
function explain(text){
  bounded(text);const raw=text.trim();if(!raw)throw Error('请粘贴执行计划');
  const rows=[];let value;try{value=JSON.parse(raw);}catch{}
  if(value){const first=Array.isArray(value)?value[0]:value;const add=(node,depth,engine)=>{const name=node['Node Type']||node.table_name||node.operation||node.access_type||'节点',access=node.access_type||node['Node Type']||'';rows.push({name:String(name),engine,depth,relation:String(node['Relation Name']||node.table_name||''),type:String(access),index:String(node['Index Name']||node.key||''),estimated:node['Plan Rows']??node.rows_examined_per_scan??node.rows??'',actual:node['Actual Rows']??node.rows_produced_per_join??'',time:node['Actual Total Time']??node.actual_time??'',warning:/seq scan|table scan|^ALL$/i.test(access),detail:[access,node['Relation Name']||'',node['Plan Rows']!=null?`估算 ${node['Plan Rows']} 行`:'',node['Actual Rows']!=null?`实际 ${node['Actual Rows']} 行`:'',node['Actual Total Time']!=null?`${node['Actual Total Time']} ms`:''].filter(Boolean).join(' · ')});};
    const stack=[{node:first,depth:0}];while(stack.length){const {node,depth}=stack.pop();if(depth>256||rows.length>20000)throw Error('执行计划层级或节点数量过大');if(Array.isArray(node)){for(let i=node.length-1;i>=0;i--)stack.push({node:node[i],depth});continue;}if(!node||typeof node!=='object')continue;const isPlan=!!node['Node Type']||!!node.table_name||!!node.access_type;if(isPlan)add(node,depth,first?.Plan?'PostgreSQL · JSON':'MySQL · JSON');for(const [key,child] of Object.entries(node).reverse())if(child&&typeof child==='object')stack.push({node:child,depth:depth+(isPlan||key==='nested_loop'?1:0)});}if(rows.length)return rows;throw Error('未识别 PostgreSQL 或 MySQL 执行计划节点');
  }
  const lines=raw.split(/\r?\n/).filter(x=>x.trim());const headerIndex=lines.findIndex(line=>/select_type/i.test(line)&&/table/i.test(line)&&/rows/i.test(line));
  if(headerIndex>=0){const columns=line=>line.trim().replace(/^\||\|$/g,'').split(line.includes('|')?'|':'\t').map(x=>x.trim()),header=columns(lines[headerIndex]).map(x=>x.toLowerCase());for(const line of lines.slice(headerIndex+1)){const values=columns(line);if(values.length!==header.length||values.every(x=>/^[+\-]+$/.test(x)))continue;const cell=key=>values[header.indexOf(key)]??'';rows.push({name:cell('table'),relation:cell('table'),type:cell('type'),index:cell('key'),estimated:cell('rows'),actual:'',time:'',depth:0,engine:'MySQL · 表格',warning:cell('type')==='ALL',detail:cell('extra')});}return rows;}
  if(!/cost=|actual time=|rows=/i.test(raw))throw Error('未识别执行计划。支持 PostgreSQL JSON/文本及 MySQL JSON/TREE/表格');
  return lines.map(line=>({name:line.trim().replace(/^->\s*/,''),detail:line.match(/\((.*?)\)/)?.[1]??'',engine:/->.*(?:table scan|index lookup)/i.test(raw)?'MySQL · TREE':'PostgreSQL · 文本',depth:Math.floor((line.match(/^\s*/)?.[0].length??0)/2),relation:line.match(/\bon\s+(\S+)/)?.[1]??'',type:line.trim().split('(')[0],index:'',estimated:line.match(/rows=(\d+)/)?.[1]??'',actual:line.match(/actual[^)]*rows=(\d+)/)?.[1]??'',time:line.match(/actual time=[\d.]+\.\.([\d.]+)/)?.[1]??'',warning:/seq scan|full table scan|table scan|\bALL\b/i.test(line)}));
}
module.exports={parseConfig,configDiff,parseLogs,logFields,logGroups,parseParameters,restoreSQL,explain};
