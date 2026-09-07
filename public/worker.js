import {normalize,trackKey,aggregate,parseFile,spotifyID,periodRange,resetCalendarCache,metadataRecord} from './engine.js';
import {buildProfile} from './profile.js';
import {Enrichment} from './enrichment.js';
import {prioritizedSpotifyIDs} from './priority.js';
let events=[],durations={},demo=true,revision=0,importing=false;
const resultsCache=new Map();
function invalidate(){revision++;resultsCache.clear();}
const db=()=>new Promise((resolve,reject)=>{const r=indexedDB.open('listening-atlas',1);r.onupgradeneeded=()=>r.result.createObjectStore('data');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
async function saved(mode,value,key='history'){const d=await db();return new Promise((resolve,reject)=>{const tx=d.transaction('data',mode==='get'?'readonly':'readwrite'),s=tx.objectStore('data');let r;if(mode==='get')r=s.get(key);else if(mode==='clear')r=s.delete(key);else r=s.put(value,key);tx.oncomplete=()=>{d.close();resolve(r.result)};tx.onerror=()=>{d.close();reject(tx.error)};});}
function normalizeMetadata(input){const output={};for(const [key,value] of Object.entries(input||{})){const id=spotifyID(key);if(!id)continue;const record=metadataRecord(value,key);if(record)output[id]=record;}return output;}
const ids=()=>prioritizedSpotifyIDs(events);
const send=message=>self.postMessage(message);
const enrichment=new Enrichment({getMetadata:()=>durations,apply:async records=>{
  let changed=false;for(const row of records){if(!spotifyID(row.spotify_track_id))continue;const record={...row,source:'spotify'};
    if(durations[row.spotify_track_id]?.source==='independent')continue;
    durations[row.spotify_track_id]=record;changed=true;
  }
  if(changed){invalidate();try{await saved('put',durations,'duration_metadata_v2')}catch{send({type:'notice',text:'Metadata is available this session but could not be saved in this browser.'})}send({type:'metadata_updated'});}
},onState:state=>send({type:'enrichment',...state})});
function makeDemo(){const songs=[['Paris','Sabrina Carpenter','Singular: Act I'],['Almost Love','Sabrina Carpenter','Singular: Act I'],['Bad Time','Sabrina Carpenter','Singular: Act I'],['Con Altura','ROSALÍA','Con Altura'],['Blinding Lights','The Weeknd','After Hours'],['Levitating','Dua Lipa','Future Nostalgia'],['Midnight City','M83','Hurry Up, We’re Dreaming'],['Good Luck, Babe!','Chappell Roan','Good Luck, Babe!'],['Espresso','Sabrina Carpenter','Short n’ Sweet'],['Get Lucky','Daft Punk','Random Access Memories'],['Feather','Sabrina Carpenter','emails i can’t send fwd:'],['Style','Taylor Swift','1989']];let seed=781;const random=()=>{seed=(seed*16807)%2147483647;return seed/2147483647};const end=Date.UTC(2026,7,31,22);events=[];for(let day=0;day<200;day++){const n=10+Math.floor(random()*45);for(let i=0;i<n;i++){const idx=Math.floor(Math.pow(random(),day<30?2:1)*songs.length),[name,artist,album]=songs[idx];const skip=random()<.11;events.push({t:end-day*86400000-i*240000,ms:skip?Math.floor(random()*40000):160000+Math.floor(random()*90000),uri:'demo:'+idx,name,artist,album,skip,platform:random()<.7?'iOS':'Windows',start:'clickrow',end:skip?'fwdbtn':'trackdone',country:'CA',shuffle:false,offline:false});}}demo=true;durations={};}
function demoMetadata(){for(let i=0;i<12;i++)durations['demo:'+i]={duration_ms:210000+i*2000,source:'demo'};}
function compute(q){
  const r=periodRange(events,q);const expiry=Object.values(durations).filter(x=>x.source==='spotify'&&x.expires_at>Date.now()).reduce((n,x)=>Math.min(n,x.expires_at),Infinity);
  const key=JSON.stringify([revision,r.from,r.to,q.threshold,q.timezone,expiry]);
  if(resultsCache.has(key))return resultsCache.get(key);
  const data={...r,current:aggregate(events,r.from,r.to,q.threshold,q.timezone,durations),previous:aggregate(events,r.previousFrom,r.previousTo,q.threshold,q.timezone,durations),demo,total:events.length};
  if(resultsCache.size>=3)resultsCache.delete(resultsCache.keys().next().value);resultsCache.set(key,data);return data;
}
function summary(a){const {tracks,artists,albums,history,...small}=a;return {...small,trackCount:tracks.length,artistCount:artists.length,albumCount:albums.length};}
function ready(note){invalidate();send({type:'ready',demo,note});}
self.onmessage=async({data:m})=>{
  try{
    if(m.type==='init'){
      let stored,metadata;try{stored=await saved('get');metadata=await saved('get',null,'duration_metadata_v2')}catch{}
      if(stored?.events?.length){events=stored.events;durations={...normalizeMetadata(stored.durations),...normalizeMetadata(metadata)};demo=false;}
      else {makeDemo();demoMetadata();}
      ready();if(!demo)enrichment.run(ids());else send({type:'enrichment',state:'demo'});
    }else if(m.type==='demo'){
      enrichment.cancel();makeDemo();demoMetadata();resetCalendarCache();ready('Demo mode. Reload to return to your saved import.');send({type:'enrichment',state:'demo'});
    }else if(m.type==='clear'){
      enrichment.cancel();await saved('clear');makeDemo();demoMetadata();resetCalendarCache();ready('Saved history removed. Showing demo data.');send({type:'enrichment',state:'demo'});
    }else if(m.type==='import'){
      if(importing)throw Error('An import is already in progress.');importing=true;enrichment.cancel();
      try{
        const next=[],seen=new Set();let invalid=0,duplicates=0,last=0;
        for(const file of m.files){await parseFile(file,r=>{const e=normalize(r);if(!e){invalid++;return;}const key=JSON.stringify(e);if(seen.has(key)){duplicates++;return;}seen.add(key);next.push(e)},p=>{if(Date.now()-last>150){send({type:'progress',text:`Reading ${file.name} · ${Math.round(p*100)}% · ${next.length.toLocaleString()} music events`});last=Date.now();}});}
        if(!next.length)throw Error('No valid music events found. Choose Extended Streaming History JSON files containing ts, ms_played and master_metadata_track_name.');
        let storedMetadata={};try{storedMetadata=await saved('get',null,'duration_metadata_v2')}catch{}
        const keep=demo?{}:durations;
        events=next;demo=false;durations={...normalizeMetadata(storedMetadata),...keep};resetCalendarCache();
        let note=`Imported ${next.length.toLocaleString()} music events. ${duplicates.toLocaleString()} exact duplicates removed; ${invalid.toLocaleString()} non-music or invalid entries excluded.`;
        try{await saved('put',{events});await saved('put',durations,'duration_metadata_v2')}catch{note+=' Browser storage is unavailable or full. Keep your original files; this session remains usable.';}
        ready(note);enrichment.run(ids(),{fetchMissing:true});
      }finally{importing=false;}
    }else if(m.type==='metadata'){
      const rows=JSON.parse(await m.file.text());if(!Array.isArray(rows))throw Error('Metadata must be a JSON array.');
      let count=0;for(const row of rows){const id=spotifyID(row.spotify_track_id||row.spotify_track_uri);const record=metadataRecord({duration_ms:row.duration_ms,source:m.independent?'independent':'legacy_unknown'},id);
        if(id&&record){durations[id]=record;count++;}}
      if(!count)throw Error('No valid exact-ID track durations found.');
      invalidate();let note=`Added duration metadata for ${count} records.`;
      if(!demo)try{await saved('put',durations,'duration_metadata_v2')}catch{note+=' Available for this session only; browser storage failed.';}
      send({type:'notice',text:note});send({type:'metadata_updated'});
    }else if(m.type==='enrich'){
      if(!demo&&!importing)enrichment.run(ids(),{fetchMissing:true});
    }else if(m.type==='pause_enrichment'){
      enrichment.cancel();send({type:'enrichment',state:'paused'});
    }else if(m.type==='query'){
      const d=compute(m.query),type=m.view,search=m.search.toLowerCase();
      let rows=type==='history'?d.current.history:type==='trends'?d.current.tracks:d.current[type]||d.current.tracks;
      if(type==='trends'){const prev=new Map(d.previous.tracks.map(x=>[x.key,x.plays]));rows=rows.map(x=>({...x,previous:prev.get(x.key)||0,change:x.plays-(prev.get(x.key)||0)}));}
      rows=rows.filter(x=>[x.name,x.artist,x.album].some(y=>y.toLowerCase().includes(search)));const sort=m.sort||'plays';
      rows.sort((a,b)=>sort==='name'?a.name.localeCompare(b.name):sort==='skip'?(b.known?b.skips/b.known:-1)-(a.known?a.skips/a.known:-1):(b[sort]||0)-(a[sort]||0));
      send({type:'result',id:m.id,data:{...d,current:summary(d.current),previous:summary(d.previous),rows:rows.slice(m.page*25,m.page*25+25),count:rows.length,topTracks:d.current.tracks.slice(0,6),topArtists:d.current.artists.slice(0,5)}});
    }else if(m.type==='detail'){
      const selected=events.filter(e=>m.kind==='artists'?e.artist===m.key:m.kind==='albums'?JSON.stringify([e.artist,e.album])===m.key:trackKey(e)===m.key),r=periodRange(events,m.query);
      const a=aggregate(selected,r.from,r.to,m.query.threshold,m.query.timezone,durations);
      const row=m.kind==='artists'?a.artists.find(x=>x.key===m.key):m.kind==='albums'?a.albums.find(x=>x.key===m.key):a.tracks.find(x=>x.key===m.key);
      send({type:'detail',data:{...summary(a),history:a.history.slice(0,25),identity:row,kind:m.kind},kind:m.kind});
    }else if(m.type==='export'){
      send({type:'export',profile:buildProfile(events,durations,m.query,demo)});
    }
  }catch(error){send({type:'error',text:error.message||String(error)});}
};
