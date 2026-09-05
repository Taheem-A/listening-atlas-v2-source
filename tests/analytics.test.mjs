import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalize,parseFile,aggregate,spotifyID,periodRange,metadataFor} from '../public/engine.js';
import {buildProfile} from '../public/profile.js';
export const ID='72DnQlaqdNhz9QJZXfYe6L', OTHER='11dFghVXANMlKmJXsNCbNl';
export const event=(ms,t=Date.UTC(2026,7,31),uri='spotify:track:'+ID)=>({t,ms,uri,name:'Song',artist:'Artist',album:'Album',skip:null});
const meta={[ID]:{duration_ms:100000,source:'independent'}};
const q={range:'30',threshold:30000,timezone:'America/Toronto'};
test('A: stream import handles split Unicode, nested values, escaped braces and malformed input',async()=>{
 const raw=[{ts:'2026-08-31T02:00:00Z',ms_played:123,master_metadata_track_name:'🎵 "{hello}"',extra:{n:[1,2]}}];
 const bytes=new TextEncoder().encode(JSON.stringify(raw));let i=0,rows=[];await parseFile({size:bytes.length,stream:()=>new ReadableStream({pull(c){if(i<bytes.length)c.enqueue(bytes.slice(i,i+=2));else c.close()}})},r=>rows.push(r));assert.deepEqual(rows,raw);assert.equal(normalize(rows[0]).ms,123);
 for(const text of ['[{},]','[{}{}]','[{','{}','[]more'])await assert.rejects(()=>parseFile(new Blob([text]),()=>{}));
});
test('exact Spotify identity; no title matching or alternate-ID merge',()=>{
 assert.equal(spotifyID('spotify:track:'+ID),ID);assert.equal(spotifyID(ID),ID);assert.equal(spotifyID('spotify:local:foo'),null);assert.equal(spotifyID('bad'),null);
 const a=aggregate([event(10000),event(10000,1,'spotify:track:'+OTHER)],0,Infinity,0,'UTC',meta);assert.equal(a.tracks.length,2);assert.equal(a.completion.known_events,1);
 assert.equal(metadataFor(event(10,1,''),{'':{duration_ms:20}}),null);
});
test('E,F,P: all thresholds, listening time and known skip behavior stay independent',()=>{
 const events=[event(0),event(29999),event(30000),event(59999),event(60000)];events[0].skip=true;events[1].skip=false;
 for(const [threshold,plays] of [[0,5],[30000,3],[60000,1]]){const a=aggregate(events,0,Infinity,threshold,'UTC',meta);assert.equal(a.plays,plays);assert.equal(a.ms,179998);assert.equal(a.events,5);assert.equal(a.plays_30s,3);assert.equal(a.plays_60s,1);assert.equal(a.known,2);assert.equal(a.skips,1);}
});
test('M,N,O: partial metadata, zero duration, capping, exact median and denominators',()=>{
 const events=[event(0),event(25000),event(75000),event(90000),event(200000),event(10000,1,'spotify:track:'+OTHER)];const a=aggregate(events,0,Infinity,0,'UTC',meta);
 assert.equal(a.completion.known_events,5);assert.equal(a.completion.coverage,5/6);assert.equal(a.completion.mean,2.9/5);assert.equal(a.completion.median,.75);assert.equal(a.completion.full_listen_rate,2/5);assert.equal(a.completion.near_complete_rate,3/5);assert.equal(a.completion.early_exit_rate,1/5);assert.equal(a.ms,400000);assert.equal(a.completion.known_listening_time_coverage,390000/400000);
 for(const duration of [0,-1,NaN,Infinity,86400001,'100000'])assert.equal(aggregate(events,0,Infinity,0,'UTC',{[ID]:{duration_ms:duration}}).completion.known_events,0);
 assert.equal(aggregate([],0,Infinity).completion.mean,null);
});
test('artist/album and period completion are event-weighted',()=>{
 const events=[event(100000),...Array.from({length:100},()=>event(10000,1,'spotify:track:'+OTHER))],m={...meta,[OTHER]:{duration_ms:100000,source:'independent'}};
 const a=aggregate(events,0,Infinity,0,'UTC',m);for(const x of [a,a.artists[0],a.albums[0]]){assert.ok(Math.abs(x.completion.mean-11/101)<1e-10);assert.equal(x.completion.median,.1);}
});
test('C,D: all date windows, custom UTC boundaries, non-overlap, timezone',()=>{
 const now=Date.UTC(2026,7,31,2),events=[event(100,now),event(100,now-86400000*200)];
 for(const days of [7,30,90,180]){const r=periodRange(events,{range:String(days)});assert.equal(r.to-r.from+1,days*86400000);assert.equal(r.previousTo+1,r.from);assert.equal(r.previousTo-r.previousFrom,r.to-r.from);assert.equal(aggregate(events,r.from,r.to).events,1);}
 const all=periodRange(events,{range:'all'});assert.equal(aggregate(events,all.from,all.to).events,2);
 const custom=periodRange(events,{range:'custom',from:now-100,to:now});assert.equal(aggregate(events,custom.from,custom.to).events,1);
 assert.equal(aggregate([event(1,now)],0,Infinity,0,'America/Toronto').days[0][0],'2026-08-30');assert.equal(aggregate([event(1,now)],0,Infinity,0,'UTC').days[0][0],'2026-08-31');
});
test('Q,R,S,T,U: deterministic compact schema v2, all counts, source-aware completion',()=>{
 const events=[event(200000),event(30000),event(10000),event(50000,Date.UTC(2026,7,31),'spotify:track:'+OTHER)],m={...meta,[OTHER]:{duration_ms:100000,source:'spotify',expires_at:Date.now()+86400000}};
 const p=buildProfile(events,m,q,false,1);assert.equal(p.schema_version,2);assert.deepEqual(p.selected_period.plays,{all_events:4,gte_30_seconds:3,gte_60_seconds:1});assert.equal(p.selected_period.completion.known_events,3);assert.equal(p.selected_period.completion.coverage,.75);assert.equal(p.windows.last_180_days.plays.all_events,4);assert.equal(p.windows.all_time.plays.all_events,4);
 const text=JSON.stringify(p);assert.deepEqual(JSON.parse(text),p);assert.equal(text.includes('duration_ms":'),false);assert.equal(text.includes('SPOTIFY_CLIENT_SECRET'),false);assert.equal(text.includes('platform'),false);assert.deepEqual(buildProfile(events,m,q,false,1),p);
 const another=buildProfile(events,m,{...q,threshold:60000},false,1);assert.deepEqual(another.selected_period,p.selected_period);assert.deepEqual(another.windows,p.windows);
});
test('Spotify and legacy-unknown metadata never feed AI completion; expired cache excluded locally',()=>{
 for(const source of ['spotify','legacy_unknown']){const m={[ID]:{duration_ms:100000,source,expires_at:Date.now()+10000}};assert.equal(buildProfile([event(50000)],m,q).selected_period.completion.mean,null);}
 assert.equal(aggregate([event(50000)],0,Infinity,0,'UTC',{[ID]:{duration_ms:100000,source:'spotify',expires_at:1}}).completion.mean,null);
});
test('export includes cooling-to-zero tracks and artist momentum',()=>{
 const now=Date.UTC(2026,7,31);const events=[event(60000,now),event(60000,now-86400000*40,'spotify:track:'+OTHER)];const p=buildProfile(events,meta,q);const cooled=p.momentum.tracks.find(x=>x.track_uri.endsWith(OTHER));assert.equal(cooled.change.gte_30_seconds,-1);assert.ok(p.momentum.artists.length);
});
test('100,000 events: one-pass aggregation remains practical',()=>{
 const events=Array.from({length:100001},(_,i)=>event(i%2?10000:100000,Date.UTC(2026,7,31)-i*1000));const start=performance.now();const a=aggregate(events,0,Infinity,30000,'UTC',meta);assert.equal(a.events,100001);assert.equal(a.plays_30s,50001);assert.equal(a.completion.known_events,100001);console.log('100k aggregation milliseconds:',Math.round(performance.now()-start));
});
