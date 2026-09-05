import {parentPort,workerData} from 'node:worker_threads';import 'fake-indexeddb/auto';
let d;await new Promise((resolve,reject)=>{const r=indexedDB.open('listening-atlas',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onsuccess=()=>{d=r.result;resolve()};r.onerror=()=>reject(r.error)});
if(workerData?.seed)await new Promise((resolve,reject)=>{const tx=d.transaction('data','readwrite');tx.objectStore('data').put(workerData.seed,'history');tx.oncomplete=resolve;tx.onerror=reject;});d.close();
globalThis.self={postMessage:m=>parentPort.postMessage(m)};
globalThis.fetch=async()=>Response.json({state:'not_configured',cache:{tracks:0}});
await import('../public/worker.js');
parentPort.on('message',async m=>{if(m.type==='read_saved'){const r=indexedDB.open('listening-atlas',1);r.onsuccess=()=>{const db=r.result,tx=db.transaction('data'),q=tx.objectStore('data').get(m.key||'history');q.onsuccess=()=>parentPort.postMessage({type:'saved',data:q.result});tx.oncomplete=()=>db.close()};return;}await self.onmessage({data:m})});
parentPort.postMessage({type:'harness_ready'});
