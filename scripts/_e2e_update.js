const http=require('http');
http.get('http://localhost:9227/json',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{
 const t=JSON.parse(d).find(x=>x.type==='page');
 const ws=new WebSocket(t.webSocketDebuggerUrl);let id=1;const P=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&P.has(m.id)){P.get(m.id)(m);P.delete(m.id);}};
 const req=(method,params={})=>new Promise(res=>{const i=id++;P.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
 ws.onopen=async()=>{
  try {
   await req('Runtime.enable');
   const ev=async(x)=>{const r=await req('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});
     if(r.result&&r.result.exceptionDetails)return{__ERR:(r.result.exceptionDetails.exception&&r.result.exceptionDetails.exception.description)||'exception'};
     return r.result&&r.result.result&&r.result.result.value;};
   await req('Runtime.evaluate',{expression:`window.__upP=[];window.api.onUpdateProgress(p=>window.__upP.push(p.percent));'ok'`});
   console.log('[step] listening progress');
   const chkExpr=`window.api.updaterCheck('').then(v=>v,e=>({__rej:e.message||String(e)}))`;
   const chk=await ev(chkExpr);
   console.log('[check]',JSON.stringify(chk));
   if(!chk||chk.__rej||!chk.hasUpdate){console.log('[stop]',JSON.stringify(chk));ws.close();process.exit(0);}
   const dl=await ev(`window.api.updaterDownload(${JSON.stringify(chk)}).then(v=>v,e=>({__rej:e.message||String(e)}))`);
   console.log('[download]',JSON.stringify(dl));
   const pcts=await ev('window.__upP');
   console.log('[progress]',JSON.stringify(pcts));
   if(!dl||dl.__rej||!dl.path){console.log('[stop download]',JSON.stringify(dl));ws.close();process.exit(1);}
   const ins=await ev(`window.api.updaterInstall(${JSON.stringify(dl.path)}).then(v=>v,e=>({__rej:e.message||String(e)}))`);
   console.log('[install]',JSON.stringify(ins));
   setTimeout(()=>{ws.close();process.exit(0);},4000);
  } catch(e) { console.error('[fatal]',e&&e.message||e); ws.close(); process.exit(1); }
 };
});});
