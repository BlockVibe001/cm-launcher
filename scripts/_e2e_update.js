const http=require('http');
http.get('http://localhost:9227/json',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{
 const t=JSON.parse(d).find(x=>x.type==='page');
 const ws=new WebSocket(t.webSocketDebuggerUrl);let id=1;const P=new Map();
 ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&P.has(m.id)){P.get(m.id)(m);P.delete(m.id);}};
 const req=(method,params={})=>new Promise(res=>{const i=id++;P.set(i,res);ws.send(JSON.stringify({id:i,method,params}));});
 ws.onopen=async()=>{
  await req('Runtime.enable');
  const ev=async(x)=>{const r=await req('Runtime.evaluate',{expression:x,awaitPromise:true,returnByValue:true});if(r.result&&r.result.exceptionDetails)return{__err:JSON.stringify(r.result.exceptionDetails.exception)};return r.result&&r.result.result&&r.result.result.value;};
  const chk=await ev(`window.api.updaterCheck('').then(v=>v,e=>'ERR:'+e.message)`);
  console.log('[check]',JSON.stringify(chk));
  ws.close();
 };
});});
