(() => {
  'use strict';
  const paths = {
    translate:'M3 3h18v14h-8l-5 4v-4H3zM6 7h7M9 5v2M7 7c0 4 4 6 6 6M12 7c0 4-3 6-6 7M16 8l-3 7M16 8l3 7M14 13h4',
    unicode:'M4 3v12a5 5 0 0 0 10 0V3M17 12h5M19.5 10v9',
    markdown:'M2 5h20v14H2zM5 15V9l3 3 3-3v6M17 9v6M14 12l3 3 3-3',
    person:'M3 5h18v14H3zM8 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4M5 16c0-4 6-4 6 0M14 9h4M14 13h4',
    terminal:'M2 4h20v16H2zM5 8l4 4-4 4M12 16h6',
    convert:'M3 7h17M16 3l4 4-4 4M21 17H4M8 13l-4 4 4 4',
    chart:'M3 3v18h18M7 16v-5M12 16V6M17 16v-8',
    list:'M4 5h1M8 5h12M4 12h1M8 12h12M4 19h1M8 19h12',
    cards:'M3 5h7v14H3zM14 5h7v14h-7z',
    sliders:'M3 5h13M20 5h1M3 12h4M11 12h10M3 19h10M17 19h4M16 3v4M7 10v4M13 17v4',
    database:'M3 5c0-4 18-4 18 0s-18 4-18 0v14c0 4 18 4 18 0V5M3 12c0 4 18 4 18 0',
    cursor:'M4 2v17l5-5 4 8 4-2-4-8h7z',
    stack:'M12 2 2 7l10 5 10-5zM2 12l10 5 10-5M2 17l10 5 10-5',
    search:'M21 21l-5.2-5.2M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0',
    clipboard:'M9 5H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4M9 2h11a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2',
    settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 2h6l1 4 4 1 2 5-3 3v4l-5 3-3-3H7l-4-4 1-4-2-4 5-2z',
    link:'M10 13a5 5 0 0 0 7 0l4-4a5 5 0 0 0-7-7l-3 3M14 11a5 5 0 0 0-7 0l-4 4a5 5 0 0 0 7 7l3-3',
    command:'M9 7V4a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v16a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V7',
    snippets:'M4 4h16M4 9h12M4 14h8M4 19h8M18 13v10M13 18h10',
    permissions:'M12 2l8 4v6c0 6-8 10-8 10S4 18 4 12V6zM9 12h6v5H9zM10 12V9a2 2 0 0 1 4 0v3',
    diagnostics:'M1 12h5l3-9 5 18 3-9h6',
    appearance:'M12 2C6 2 2 6 2 12s4 10 8 10c3 0 3-3 2-4-1-2 1-3 3-3h3c6 0 5-13-6-13M7 7h.1M13 5h.1M18 9h.1M6 13h.1',
    pin:'M8 3h8l-1 6 5 4v2H4v-2l5-4-1-6M12 15v7',
    json:'M9 3H7c-2 0-2 2-2 4v2l-2 3 2 3v2c0 2 0 4 2 4h2M15 3h2c2 0 2 2 2 4v2l2 3-2 3v2c0 2 0 4-2 4h-2',
    comparison:'M3 3h18v18H3zM12 3v18M6 8h3M6 12h3M15 8h3M15 16h3',
    image:'M3 3h18v18H3zM3 17l6-6 4 4 4-6 4 6M7 7h.1',
    file:'M5 2h9l5 5v15H5zM14 2v6h5M8 12h8M8 16h8',
    application:'M3 3h18v18H3zM3 8h18M7 5h.1M10 5h.1',
    history:'M3 6v5h5M4 10a9 9 0 1 1 1 8M12 6v6l4 3',
    text:'M3 4h18M12 4v17M7 21h10',
    arrow:'M4 12h16M13 5l7 7-7 7',
    check:'M4 12l5 5L20 6',
    close:'M5 5l14 14M5 19 19 5',
    plus:'M12 3v18M3 12h18',
    chevron:'M6 9l6 6 6-6',
    star:'m12 2 3 6 7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z'
  };
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value == null || value === false) continue;
      if (key === 'class' || key === 'className') node.className = value;
      else if (key === 'style' && typeof value === 'object') Object.entries(value).forEach(([name,v])=>name.startsWith('--')?node.style.setProperty(name,v):node.style[name]=v);
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
      else if (['value','checked','selected','disabled','tabIndex'].includes(key)) node[key] = value;
      else node.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) if (child != null && child !== false) node.append(child instanceof Node ? child : String(child));
    return node;
  }
  function icon(name, size = 20) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key,value] of Object.entries({viewBox:'0 0 24 24',width:size,height:size,fill:'none',stroke:'currentColor','stroke-width':'1.65','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) svg.setAttribute(key,value);
    const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d',paths[name] || paths.file); svg.append(path); return svg;
  }
  function notify(text, isError = false) {
    const node = document.getElementById('notice'); node.textContent = String(text); node.classList.toggle('error', isError); node.classList.add('visible');
    clearTimeout(notify.timer); notify.timer = setTimeout(() => node.classList.remove('visible'), 3000);
  }
  function button(label, action, className = '') {
    return h('button',{type:'button',class:className,onclick:async e=>{try{await action?.(e);}catch(error){notify(error.message,true);}}},label);
  }
  function iconButton(name,label,action) { const b=button('',action,'icon-button');b.title=label;b.setAttribute('aria-label',label);b.append(icon(name));return b; }
  function menu(items, anchor) {
    document.querySelector('.context-menu')?.remove();
    const box=h('div',{class:'context-menu',role:'menu'});
    for(const item of items) {
      if(!item) {box.append(h('hr'));continue;}
      const b=button(item.label,async()=>{box.remove();await item.action?.();},item.danger?'danger':'');b.disabled=!!item.disabled;b.setAttribute('role','menuitem');box.append(b);
    }
    document.body.append(box);
    const rect=anchor?.getBoundingClientRect?.()||{left:anchor?.clientX||24,bottom:anchor?.clientY||24};
    box.style.left=Math.max(6,Math.min(innerWidth-box.offsetWidth-8,rect.left))+'px';box.style.top=Math.max(6,Math.min(innerHeight-box.offsetHeight-8,rect.bottom+4))+'px';
    box.querySelector('button')?.focus();
    const close=e=>{if(!box.contains(e.target)){box.remove();document.removeEventListener('pointerdown',close,true);}};
    setTimeout(()=>document.addEventListener('pointerdown',close,true),0);
    box.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();box.remove();anchor?.focus?.();}if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();const bs=[...box.querySelectorAll('button:not(:disabled)')];bs[(bs.indexOf(document.activeElement)+(e.key==='ArrowDown'?1:-1)+bs.length)%bs.length]?.focus();}});
    return box;
  }
  function dialog(title,content,actions) {const d=h('dialog',{class:'app-dialog'},h('h2',{},title),content,h('div',{class:'dialog-actions'},actions));document.body.append(d);d.addEventListener('close',()=>d.remove());d.showModal();return d;}
  function prompt(title,value='') {return new Promise(resolve=>{const input=h('input',{value,autocomplete:'off'});let done=false;const finish=v=>{done=true;d.close();resolve(v);};const d=dialog(title,input,[button('取消',()=>finish(null)),button('保存',()=>finish(input.value),'primary')]);d.addEventListener('close',()=>{if(!done)resolve(null);});input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();finish(input.value);}});input.focus();input.select();});}
  function confirm(title,message) {return new Promise(resolve=>{let done=false;const finish=v=>{done=true;d.close();resolve(v);};const d=dialog(title,h('p',{},message),[button('取消',()=>finish(false)),button('确定',()=>finish(true),'primary')]);d.addEventListener('close',()=>{if(!done)resolve(false);});});}
  function relativeTime(time) {const n=Math.max(0,(Date.now()-new Date(time).getTime())/60000);return n<1?'刚刚':n<60?Math.floor(n)+' 分钟前':n<1440?Math.floor(n/60)+' 小时前':Math.floor(n/1440)+' 天前';}
  window.OpenAllPages=window.OpenAllPages||{};
  window.OpenAllUI={h,button,icon,iconButton,notify,menu,prompt,confirm,dialog,relativeTime};
})();
