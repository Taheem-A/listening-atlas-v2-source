export function normalize(r){if(!r||typeof r!=='object')return null;const t=Date.parse(r.ts),ms=r.ms_played;if(!Number.isFinite(t)||typeof ms!=='number'||!Number.isFinite(ms)||ms<0||!r.master_metadata_track_name)return null;return {t,ms,uri:typeof r.spotify_track_uri==='string'?r.spotify_track_uri:'',name:String(r.master_metadata_track_name),artist:String(r.master_metadata_album_artist_name||'Unknown artist'),album:String(r.master_metadata_album_album_name||'Unknown album'),skip:typeof r.skipped==='boolean'?r.skipped:null,platform:String(r.platform||'Unknown'),start:String(r.reason_start||''),end:String(r.reason_end||''),country:String(r.conn_country||''),shuffle:r.shuffle===true,offline:r.offline===true};}
export const trackKey=e=>e.uri||JSON.stringify([e.name,e.artist,e.album]);
// Stream the outer JSON array, parsing one event at a time, including nested values.
export async function parseFile(file,onRecord,onProgress=()=>{}){const reader=file.stream().getReader(),decoder=new TextDecoder();let started=false,ended=false,inString=false,escape=false,depth=0,object='',expectValue=true,count=0,bytes=0;function consume(text){for(const c of text){if(ended){if(!/\s/.test(c))throw Error('Unexpected content after JSON array.');continue;}if(!started){if(/\s|\uFEFF/.test(c))continue;if(c!=='[')throw Error('Expected a JSON array of Spotify history events.');started=true;continue;}if(depth===0){if(/\s/.test(c))continue;if(c===']'){if(expectValue&&count)throw Error('Trailing comma in JSON array.');ended=true;continue;}if(c===','&&!expectValue){expectValue=true;continue;}if(c==='{'&&expectValue){depth=1;object='{';inString=false;continue;}throw Error('Expected an event object in the JSON array.');}object+=c;if(inString){if(escape)escape=false;else if(c==='\\')escape=true;else if(c==='"')inString=false;}else if(c==='"')inString=true;else if(c==='{'||c==='[')depth++;else if(c==='}'||c===']'){depth--;if(depth===0){onRecord(JSON.parse(object));count++;object='';expectValue=false;}}}}try{while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;consume(decoder.decode(value,{stream:true}));onProgress(bytes/file.size);}consume(decoder.decode());if(!started||!ended||depth!==0)throw Error('Incomplete JSON array.');return count;}finally{reader.releaseLock();}}

export function spotifyID(value) {
  if(typeof value!=='string')return null;
  return /^(?:spotify:track:)?([a-zA-Z0-9]{22})$/.exec(value)?.[1]||null;
}
export function metadataRecord(record, key, now=Date.now()) {
  if(typeof record==='number')record={duration_ms:record,source:'legacy_unknown'};
  if(!record||!Number.isSafeInteger(record.duration_ms)||record.duration_ms<=0||record.duration_ms>86400000)return null;
  if(record.source==='spotify'&&(!Number.isFinite(record.expires_at)||record.expires_at<=now))return null;
  return {...record,spotify_track_id:spotifyID(key),duration_ms:record.duration_ms};
}
export function metadataFor(e,metadata,now=Date.now(),forExport=false) {
  const id=spotifyID(e.uri); // No fuzzy matching or enrichment of unidentified real tracks.
  if(!id&&!e.uri.startsWith('demo:'))return null;
  const record=metadataRecord(metadata[id]??metadata[e.uri],e.uri,now);
  if(!record)return null;
  if(forExport&&!['independent','demo'].includes(record.source))return null;
  return record;
}
const cmp=(a,b)=>a<b?-1:a>b?1:0;
export const rankTracks=(a,b)=>b.plays_30s-a.plays_30s||b.events-a.events||b.ms-a.ms||cmp(a.key,b.key);
function stats(){return {ms:0,plays:0,events:0,events_all:0,plays_30s:0,plays_60s:0,known:0,skips:0,first:Infinity,last:0,completionSum:0,completionCount:0,knownDurationMs:0,full:0,near:0,early:0,ratios:[],sources:{}};}
function add(x,e,record,threshold){
  x.ms+=e.ms;x.events++;x.events_all++;if(e.ms>=threshold)x.plays++;if(e.ms>=30000)x.plays_30s++;if(e.ms>=60000)x.plays_60s++;
  if(e.skip!==null){x.known++;if(e.skip)x.skips++;}x.first=Math.min(x.first,e.t);x.last=Math.max(x.last,e.t);
  if(record){const completion=Math.min(e.ms/record.duration_ms,1);x.completionSum+=completion;x.completionCount++;x.knownDurationMs+=e.ms;x.ratios.push(completion);if(completion>=.90)x.full++;if(completion>=.75)x.near++;if(completion<.25)x.early++;x.sources[record.source||'legacy_unknown']=(x.sources[record.source||'legacy_unknown']||0)+1;}
}
function finish(x){
  x.ratios.sort((a,b)=>a-b);const n=x.ratios.length,mid=Math.floor(n/2);
  x.completion={known_events:n,coverage:x.events?n/x.events:null,mean:n?x.completionSum/n:null,median:n?(n%2?x.ratios[mid]:(x.ratios[mid-1]+x.ratios[mid])/2):null,full_listen_rate:n?x.full/n:null,near_complete_rate:n?x.near/n:null,early_exit_rate:n?x.early/n:null,known_listening_time_coverage:x.ms?x.knownDurationMs/x.ms:null,sources:x.sources};
  delete x.ratios;delete x.sources;delete x.full;delete x.near;delete x.early;
  if(!x.events){x.first=null;x.last=null;}return x;
}
// A short cache of per-event calendar keys avoids repeated Intl formatting during filters.
const dayCaches=new Map();
export function resetCalendarCache(){dayCaches.clear();}
function calendar(timezone){if(!dayCaches.has(timezone)){if(dayCaches.size>=2)dayCaches.delete(dayCaches.keys().next().value);dayCaches.set(timezone,{date:new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}),keys:new WeakMap()});}return dayCaches.get(timezone);}
export function aggregate(events,from,to,threshold=0,timezone='UTC',metadata={},options={}) {
  const {date,keys}=calendar(timezone),tracks=new Map(),artists=new Map(),albums=new Map(),days=new Map(),summary=stats(),history=[];
  const now=options.now??Date.now(),recordCache=new Map();
  for(const e of events){
    if(e.t<from||e.t>to)continue;
    history.push(e);const key=trackKey(e);
    if(!recordCache.has(key))recordCache.set(key,metadataFor(e,metadata,now,options.forExport));
    const record=recordCache.get(key);add(summary,e,record,threshold);
    let day=keys.get(e);if(!day){day=date.format(new Date(e.t));keys.set(e,day);}days.set(day,(days.get(day)||0)+e.ms);
    for(const [map,k,name] of [[tracks,key,e.name],[artists,e.artist,e.artist],[albums,JSON.stringify([e.artist,e.album]),e.album]]){
      if(!map.has(k))map.set(k,{...stats(),key:k,name,artist:e.artist,album:e.album,uri:e.uri});add(map.get(k),e,record,threshold);
    }
  }
  const list=[...tracks.values()].map(finish),enriched=list.filter(t=>t.completionCount>0).length,identified=list.filter(t=>spotifyID(t.uri)).length;
  return {...finish(summary),tracks:list.sort((a,b)=>b.plays-a.plays||b.ms-a.ms||cmp(a.key,b.key)),artists:[...artists.values()].map(finish).sort((a,b)=>b.ms-a.ms||cmp(a.key,b.key)),albums:[...albums.values()].map(finish).sort((a,b)=>b.ms-a.ms||cmp(a.key,b.key)),days:[...days].sort((a,b)=>cmp(a[0],b[0])),history:history.sort((a,b)=>b.t-a.t),coverage:{tracks_total:tracks.size,tracks_with_spotify_ids:identified,tracks_missing_ids:tracks.size-identified,tracks_enriched:enriched,track_coverage:tracks.size?enriched/tracks.size:null,events_with_duration:summary.completionCount,event_coverage:summary.events?summary.completionCount/summary.events:null,listening_time_coverage:summary.ms?summary.knownDurationMs/summary.ms:null}};
}
export function periodRange(events,q) {
  const latest=events.reduce((a,e)=>Math.max(a,e.t),0),earliest=events.reduce((a,e)=>Math.min(a,e.t),Infinity);
  let from=q.range==='all'?(Number.isFinite(earliest)?earliest:0):latest-Number(q.range)*86400000+1,to=latest;
  if(q.range==='custom'){from=q.from;to=q.to;}
  if(!Number.isFinite(from)||!Number.isFinite(to)||from>to)throw Error('Invalid period boundaries.');
  const span=to-from+1;return{from,to,previousFrom:from-span,previousTo:from-1,latest};
}
