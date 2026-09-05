import {test} from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {readFileSync,readdirSync} from 'node:fs';
import {MetadataCache} from '../server/cache.js';import {SpotifyClient,SpotifyFailure,retryAfter} from '../server/spotify.js';import {enrich,handleAPI} from '../server/api.js';
const ID='72DnQlaqdNhz9QJZXfYe6L',OTHER='11dFghVXANMlKmJXsNCbNl';
export function testDB(){const db=new DatabaseSync(':memory:');for(const file of readdirSync('drizzle').filter(x=>x.endsWith('.sql')))db.exec(readFileSync('drizzle/'+file,'utf8'));return{prepare(sql){let args=[];return{bind(...values){args=values;return this},async run(){const r=db.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}}},async first(){return db.prepare(sql).get(...args)||null},async all(){return{results:db.prepare(sql).all(...args)}}}},close:()=>db.close()};}
const token=()=>Response.json({access_token:'TEST_TOKEN',token_type:'Bearer',expires_in:3600});
const env={SPOTIFY_CLIENT_ID:'TEST_ID',SPOTIFY_CLIENT_SECRET:'TEST_SECRET',SPOTIFY_ANALYTICS_PERMISSION:'granted'};
const track=()=>Response.json({id:ID,type:'track',duration_ms:207000});
function request(path,body={ids:[ID]}){return new Request('https://atlas.test/api/spotify/'+path,{method:'POST',headers:{'Origin':'https://atlas.test','Content-Type':'application/json','X-Atlas-Request':'metadata','oai-authenticated-user-id':'test-user'},body:JSON.stringify(body)})}
test('H fixture: server client credentials + exact ID track duration; cached token',async()=>{
 const calls=[];const client=new SpotifyClient(env,{fetcher:async(url,options)=>{calls.push({url,options});return url.includes('/api/token')?token():track()}});assert.equal((await client.track(ID)).duration,207000);await client.track(ID);assert.equal(calls.filter(c=>c.url.includes('/api/token')).length,1);assert.equal(calls[1].url,'https://api.spotify.com/v1/tracks/'+ID+'?market=CA');assert.equal(calls[0].options.body,'grant_type=client_credentials');assert.equal(calls[1].options.body,undefined);
});
test('I: persistent D1 cache avoids repeat requests across service instances',async()=>{
 const db=testDB(),cache=new MetadataCache(db);let now=1000,calls=0;const client={track:async()=>{calls++;return{status:'ready',duration:207000}}},deps={clock:()=>now,sleep:async ms=>{now+=ms}};
 await enrich([ID],cache,client,deps);await enrich([ID],new MetadataCache(db),client,deps);assert.equal(calls,1);assert.equal((await cache.get([ID]))[0].duration_ms,207000);db.close();
});
test('J: 404 permanent failure cached; malformed ID and relinking rejected',async()=>{
 const client=new SpotifyClient(env,{fetcher:async url=>url.includes('/api/token')?token():new Response('',{status:404})});assert.equal((await client.track(ID)).status,'unavailable');
 const changed=new SpotifyClient(env,{fetcher:async url=>url.includes('/api/token')?token():Response.json({id:OTHER,type:'track',duration_ms:12})});assert.equal((await changed.track(ID)).status,'identity_mismatch');
 const r=await handleAPI(request('enrich',{ids:['../../bad']}),env);assert.equal(r.status,400);
});
test('K: network/5xx outages isolated; transient attempts capped at three',async()=>{
 const client=new SpotifyClient(env,{fetcher:async()=>{throw Error('TEST_SECRET must not escape')}});await assert.rejects(()=>client.track(ID),e=>e.message==='temporary_error');
 const db=testDB(),cache=new MetadataCache(db);let now=0,calls=0;const broken={track:async()=>{calls++;throw new SpotifyFailure('temporary_error')}};
 for(let i=0;i<5;i++){await enrich([ID],cache,broken,{clock:()=>now,sleep:async()=>{}});now+=400000;}assert.equal(calls,3);assert.equal((await cache.get([ID]))[0].attempts,3);db.close();
});
test('L: Retry-After respected globally, across IDs and service instances',async()=>{
 const now=10000;assert.equal(retryAfter('120',now),130000);assert.ok(retryAfter(null,now)>=now+60000);
 const client=new SpotifyClient(env,{fetcher:async url=>url.includes('/api/token')?token():new Response('',{status:429,headers:{'Retry-After':'120'}}),clock:()=>now});
 const db=testDB(),cache=new MetadataCache(db);const r=await enrich([ID],cache,client,{clock:()=>now,sleep:async()=>{}});assert.equal(r.state,'rate_limited');assert.equal(r.retry_at,130000);
 let calls=0;const r2=await enrich([OTHER],new MetadataCache(db),{track:async()=>{calls++}},{clock:()=>now+1000,sleep:async()=>{}});assert.equal(r2.state,'rate_limited');assert.equal(calls,0);db.close();
});
test('expired token refreshed once; repeated 401 and access denial stop',async()=>{
 let tokens=0,tracks=0;const c=new SpotifyClient(env,{fetcher:async url=>url.includes('/api/token')?(tokens++,token()):(++tracks===1?new Response('',{status:401}):track())});assert.equal((await c.track(ID)).duration,207000);assert.equal(tokens,2);
 const fail=new SpotifyClient(env,{fetcher:async url=>url.includes('/api/token')?token():new Response('',{status:401})});await assert.rejects(()=>fail.track(ID),e=>e.status==='credentials_error');
});
test('G,U: auth, same-origin, exact body allowlist; credentials never serialized',async()=>{
 let r=await handleAPI(new Request('https://atlas.test/api/spotify/status'),env);assert.equal(r.status,401);
 r=await handleAPI(request('lookup',{ids:[ID],ms_played:1000}),env);assert.equal(r.status,400);
 r=await handleAPI(new Request('https://atlas.test/api/spotify/enrich',{method:'POST',headers:{Origin:'https://evil.test','Content-Type':'application/json','X-Atlas-Request':'metadata','oai-authenticated-user-id':'u'},body:JSON.stringify({ids:[ID]})}),env);assert.equal(r.status,403);
 r=await handleAPI(new Request('https://atlas.test/api/spotify/status',{headers:{'oai-authenticated-user-id':'u'}}),env);const text=await r.text();assert.equal(text.includes('TEST_SECRET'),false);assert.equal(text.includes('TEST_ID'),false);
});
test('missing credentials and policy permission produce usable non-error states',async()=>{
 assert.equal((await (await handleAPI(request('enrich'),{})).json()).state,'not_configured');
 assert.equal((await (await handleAPI(request('enrich'),{SPOTIFY_CLIENT_ID:'x',SPOTIFY_CLIENT_SECRET:'y'})).json()).state,'permission_required');
});
test('single D1 lease serializes concurrent requests and expired lease recovers',async()=>{
 const db=testDB(),cache=new MetadataCache(db);assert.equal(await cache.claim(0,'one'),true);assert.equal(await cache.claim(1,'two'),false);assert.equal(await cache.claim(180001,'two'),true);await cache.release('one',999999);assert.equal((await cache.control()).lock_token,'two');db.close();
});
test('cache expiration purges duration records without unrelated tables',async()=>{
 const db=testDB(),cache=new MetadataCache(db);await cache.put({spotify_track_id:ID,duration_ms:200000,metadata_status:'ready',fetched_at:0,expires_at:1000,retry_at:0,attempts:0});await cache.prune(1001);assert.equal((await cache.get([ID])).length,0);db.close();
});
test('large lookup requests are accepted and cache queries remain capped at 80 IDs',async()=>{
 const ids=Array.from({length:1000},(_,i)=>i.toString(36).padStart(22,'0')),batches=[];
 const db={prepare(){return{bind(...values){batches.push(values);return this},async all(){return{results:[]}}}}};
 assert.deepEqual(await new MetadataCache(db).get(ids),[]);assert.equal(batches.length,13);assert.equal(Math.max(...batches.map(x=>x.length)),80);
 let received=0;const cache={prune:async()=>{},get:async values=>{received=values.length;return[]}};
 let r=await handleAPI(request('lookup',{ids}),{...env,DB:{}},{cache});assert.equal(r.status,200);assert.equal(received,1000);
 r=await handleAPI(request('lookup',{ids:[...ids,'zzzzzzzzzzzzzzzzzzzzzz']}),{...env,DB:{}},{cache});assert.equal(r.status,400);
});
