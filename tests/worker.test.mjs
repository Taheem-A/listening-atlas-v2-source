import {test} from 'node:test';import assert from 'node:assert/strict';import {Worker} from 'node:worker_threads';
import {Enrichment} from '../public/enrichment.js';
const ID='72DnQlaqdNhz9QJZXfYe6L';
const old={events:[{t:Date.UTC(2026,7,31),ms:60000,uri:'spotify:track:'+ID,name:'Existing song',artist:'Existing artist',album:'Existing album',skip:false}],durations:{['spotify:track:'+ID]:100000}};
function wait(w,type){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cleanup();reject(Error('Timeout: '+type))},10000);const listener=m=>{if(m.type===type){cleanup();resolve(m)}};const onError=e=>{cleanup();reject(e)};function cleanup(){clearTimeout(timer);w.off('message',listener);w.off('error',onError)}w.on('message',listener);w.on('error',onError)})}
async function call(w,message,type){const p=wait(w,type);w.postMessage(message);return p;}
const query={range:'all',threshold:0,timezone:'UTC'};
test('B,V: old IndexedDB history and duration migration, safe demo switching, no destructive migration',async()=>{
 const w=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{seed:old}});try{await wait(w,'harness_ready');await call(w,{type:'init'},'ready');let r=await call(w,{type:'query',query,view:'tracks',search:'',sort:'plays',page:0,id:1},'result');assert.equal(r.data.demo,false);assert.equal(r.data.rows[0].name,'Existing song');assert.equal(r.data.rows[0].completion.mean,.6);
 const p=await call(w,{type:'export',query},'export');assert.equal(p.profile.schema_version,3);assert.equal(p.profile.periods.selected.completion.mean,.6);const sourceCol=p.profile.events.columns.indexOf('duration_source');assert.equal(p.profile.events.rows[0][sourceCol],'legacy_unknown');
 await call(w,{type:'demo'},'ready');r=await call(w,{type:'query',query,view:'overview',search:'',sort:'plays',page:0,id:2},'result');assert.equal(r.data.demo,true);assert.ok(r.data.current.completion.known_events>0);
 const stored=await call(w,{type:'read_saved'},'saved');assert.deepEqual(stored.data,old);
 await call(w,{type:'init'},'ready');r=await call(w,{type:'query',query,view:'tracks',search:'',sort:'plays',page:0,id:3},'result');assert.equal(r.data.rows[0].name,'Existing song');
 }finally{await w.terminate()}
});
test('A,B: full and partial imports merge, deduplicate, and preserve duration metadata',async()=>{
 const w=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{seed:old}});
 try{
  await wait(w,'harness_ready');await call(w,{type:'init'},'ready');
  const metadata=new Blob([JSON.stringify([{spotify_track_uri:'spotify:track:'+ID,duration_ms:200000}])]);
  await call(w,{type:'metadata',file:metadata,independent:true},'metadata_updated');
  const raw={ts:'2026-09-01T00:00:00Z',ms_played:100000,spotify_track_uri:'spotify:track:'+ID,master_metadata_track_name:'Existing song',master_metadata_album_artist_name:'Existing artist',master_metadata_album_album_name:'Existing album',skipped:false};
  const incoming=new Blob([JSON.stringify([raw,raw])]);
  let notice=await call(w,{type:'import',files:[incoming]},'ready');
  assert.match(notice.note,/1 new/);
  let r=await call(w,{type:'query',query,view:'tracks',search:'',sort:'plays',page:0,id:1},'result');
  assert.equal(r.data.total,2);assert.equal(r.data.rows[0].completion.mean,.4);
  // A complete history export can be imported again without double counting.
  notice=await call(w,{type:'import',files:[incoming]},'ready');assert.match(notice.note,/0 new/);
  r=await call(w,{type:'query',query,view:'tracks',search:'',sort:'plays',page:0,id:2},'result');assert.equal(r.data.total,2);
  const persisted=await call(w,{type:'read_saved'},'saved');assert.equal(persisted.data.events.length,2);
  assert.equal(persisted.data.events[0].name,'Existing song');
  // A damaged follow-up does not overwrite the previously saved history.
  await call(w,{type:'import',files:[new Blob(['[{broken'])]},'error');
  const stillSaved=await call(w,{type:'read_saved'},'saved');assert.deepEqual(stillSaved.data,persisted.data);
  const exported=await call(w,{type:'export',query},'export');
  assert.equal(exported.profile.periods.selected.completion.mean,.4);
  const completionCol=exported.profile.events.columns.indexOf('completion_ratio_capped');
  assert.deepEqual(exported.profile.events.rows.map(row=>row[completionCol]).sort(),[.3,.5]);
 }finally{await w.terminate()}
});
test('import while exploring demo merges against saved real history, not demo rows',async()=>{
 const w=new Worker(new URL('./worker-harness.mjs',import.meta.url),{workerData:{seed:old}});
 try{
  await wait(w,'harness_ready');await call(w,{type:'init'},'ready');await call(w,{type:'demo'},'ready');
  const raw={ts:'2026-09-02T00:00:00Z',ms_played:90000,spotify_track_uri:'spotify:track:11dFghVXANMlKmJXsNCbNl',master_metadata_track_name:'Second track',master_metadata_album_artist_name:'Second artist',master_metadata_album_album_name:'Second album'};
  await call(w,{type:'import',files:[new Blob([JSON.stringify([raw])])]},'ready');
  const r=await call(w,{type:'query',query,view:'tracks',search:'',sort:'plays',page:0,id:1},'result');
  assert.equal(r.data.total,2);assert.equal(r.data.demo,false);
  const persisted=await call(w,{type:'read_saved'},'saved');
  assert.equal(persisted.data.events.length,2);
  assert.ok(persisted.data.events.some(x=>x.name==='Existing song'));
  assert.ok(persisted.data.events.some(x=>x.name==='Second track'));
 }finally{await w.terminate()}
});
test('progressive cache lookup sends unique IDs only and skips fetched metadata',async()=>{
 const metadata={},calls=[],states=[];const manager=new Enrichment({getMetadata:()=>metadata,apply:async rows=>{for(const r of rows)metadata[r.spotify_track_id]={...r,source:'spotify'}},onState:s=>states.push(s),fetcher:async(url,options)=>{calls.push({url,options});return Response.json(url.endsWith('status')?{state:'ready',cache:{}}:url.endsWith('lookup')?{state:'ready',records:[{spotify_track_id:ID,duration_ms:200000,expires_at:Date.now()+999999}]}:{state:'ready',records:[]})}});
 await manager.run([ID,ID],{fetchMissing:true});assert.equal(calls.filter(x=>x.url.endsWith('/enrich')).length,0);assert.deepEqual(JSON.parse(calls[1].options.body),{ids:[ID]});assert.equal(states.at(-1).state,'complete');
});
test('enrichment can be paused while a lookup is in flight without applying stale metadata',async()=>{
 let finish,applied=0;const manager=new Enrichment({getMetadata:()=>({}),apply:async()=>{applied++},onState:()=>{},fetcher:async url=>url.endsWith('status')?Response.json({state:'ready'}):await new Promise(r=>finish=r)});
 const running=manager.run([ID]);while(!finish)await new Promise(r=>setImmediate(r));manager.cancel();finish(Response.json({state:'ready',records:[]}));await running;assert.equal(applied,0);
});
test('large cache preflight uses approximately 1,000 IDs per browser request',async()=>{
 const ids=Array.from({length:9471},(_,i)=>i.toString(36).padStart(22,'0')),sizes=[];
 const manager=new Enrichment({getMetadata:()=>({}),apply:async()=>{},onState:()=>{},fetcher:async(url,options)=>{if(url.endsWith('status'))return Response.json({state:'ready'});sizes.push(JSON.parse(options.body).ids.length);return Response.json({state:'ready',records:[]})}});
 await manager.run(ids);assert.deepEqual(sizes,[1000,1000,1000,1000,1000,1000,1000,1000,1000,471]);
});
test('lookup HTTP failures preserve sanitized status and stage',async()=>{
 const states=[];const manager=new Enrichment({getMetadata:()=>({}),apply:async()=>{},onState:s=>states.push(s),fetcher:async url=>url.endsWith('status')?Response.json({state:'ready'}):new Response('upstream limit',{status:429})});
 await manager.run([ID]);assert.equal(states.at(-1).state,'http_error');assert.equal(states.at(-1).http_status,429);assert.equal(states.at(-1).error_stage,'lookup');
});
