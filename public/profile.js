import {aggregate,metadataFor,periodRange,rankTracks,spotifyID,trackKey} from './engine.js';

const round=(n,digits=4)=>n===null||n===undefined?null:Math.round(n*10**digits)/10**digits;
const iso=t=>t===null||t===undefined?null:new Date(t).toISOString();
export const definitions={
  plays:'All counts are simultaneous. all_events includes every valid music event, including zero milliseconds; gte_30_seconds means ms_played >= 30000; gte_60_seconds means ms_played >= 60000.',
  listening_time:'Sum of raw ms_played for all valid music events. It is not capped at track duration and includes events below play thresholds.',
  skip_rate:'skipped=true divided by events with a boolean skipped flag. Unknown skip flags are excluded; skip is not inferred from completion.',
  completion:'For each event with a valid known duration: completion_ratio_capped = min(ms_played / duration_ms, 1). Aggregate mean, exact median and rates use underlying events. Raw ratios are retained at event level so over-duration events are visible rather than hidden.',
  completion_thresholds:'full_listen is capped completion >= 0.90; near_complete is >= 0.75 and includes full listens; early_exit is < 0.25.',
  completion_coverage:'known_events / all_events. known_listening_time_coverage is raw listening time on events with known duration / all raw listening time.',
  metadata_source:'Duration metadata may come from Spotify enrichment, independently supplied files, legacy source-unknown data, or demo data. Source is retained on exported track/event records. No audio, artwork, lyrics, credentials or Spotify API response objects are exported.',
  periods:'7/30/90/180-day trailing windows end at the latest imported playback end timestamp, inclusive. All-time spans first through last imported music event. Custom start/end preserve the existing UTC-boundary behavior. Display timezone affects calendar grouping only.',
  comparison:'Preceding period has exactly the same millisecond length and ends 1 ms before the selected period begins. Lifetime has no prior-period comparison.',
  identity:'Tracks retain exact imported Spotify URI when present. Distinct Spotify IDs are never merged by title. Without a URI, title/artist/album fallback identity is retained for history only. Artists use imported album-artist name; albums use artist + album name.',
  timestamps:'Spotify history provides playback end timestamps. exact_start_time is unavailable. Local calendar fields are derived from the playback end timestamp using display_timezone.',
  event_context:'platform, reason_start, reason_end, country, shuffle, offline, incognito and offline_timestamp are retained when available from imported Extended Streaming History. Missing fields remain null/empty rather than being inferred.',
  privacy:'The analysis export intentionally omits IP addresses, decrypted user-agent strings, credentials, raw Spotify API objects, audio, artwork and lyrics.'
};

export const counts=x=>({all_events:x?.events||0,gte_30_seconds:x?.plays_30s||0,gte_60_seconds:x?.plays_60s||0});
function completion(x){return Object.fromEntries(Object.entries(x?.completion||{}).map(([k,v])=>[k,typeof v==='number'?round(v):v]));}
function metrics(x){
  if(!x)return null;
  return {
    plays:counts(x),
    listening_minutes:round(x.ms/60000),
    skip:{known_events:x.known||0,skipped_events:x.skips||0,rate:x.known?round(x.skips/x.known):null},
    completion:completion(x),
    first_played_utc:iso(x.first),
    last_played_utc:iso(x.last)
  };
}
function periodSummary(a,from,to,includeRankings=true){
  const base={
    from_utc:iso(from),to_utc:iso(to),...metrics(a),coverage:a.coverage,
    unique_tracks:a.tracks.length,unique_artists:a.artists.length,unique_albums:a.albums.length,
    listening_days:a.days.length
  };
  if(includeRankings){
    base.top_tracks=[...a.tracks].sort(rankTracks).slice(0,100).map(x=>({track_uri:x.uri||null,track:x.name,artist:x.artist,album:x.album,...metrics(x)}));
    base.top_artists=a.artists.slice(0,50).map(x=>({artist:x.name,...metrics(x)}));
    base.top_albums=a.albums.slice(0,50).map(x=>({album:x.name,artist:x.artist,...metrics(x)}));
  }
  return base;
}
function entityMaps(a){return {
  tracks:new Map(a.tracks.map(x=>[x.key,x])),
  artists:new Map(a.artists.map(x=>[x.key,x])),
  albums:new Map(a.albums.map(x=>[x.key,x]))
};}
function durationInfo(x,metadata,now){
  const probe={uri:x.uri||'',name:x.name,artist:x.artist,album:x.album};
  const r=metadataFor(probe,metadata,now,false);
  if(!r)return {known:false,duration_ms:null,source:null};
  return {known:true,duration_ms:r.duration_ms,source:r.source||'legacy_unknown',metadata_status:r.metadata_status||null,fetched_at_utc:Number.isFinite(r.fetched_at)?iso(r.fetched_at):null,expires_at_utc:Number.isFinite(r.expires_at)?iso(r.expires_at):null};
}
function fullEntities(all,current,previous,metadata,now){
  const cm=entityMaps(current),pm=previous?entityMaps(previous):{tracks:new Map(),artists:new Map(),albums:new Map()};
  const tracks=[...all.tracks].sort(rankTracks).map((x,index)=>({
    track_uri:x.uri||null,spotify_track_id:spotifyID(x.uri),track:x.name,artist:x.artist,album:x.album,
    all_time_rank_by_30s_plays:index+1,duration:durationInfo(x,metadata,now),
    metrics:{selected_period:metrics(cm.tracks.get(x.key)),previous_period:metrics(pm.tracks.get(x.key)),all_time:metrics(x)}
  }));
  const artists=all.artists.map((x,index)=>({artist:x.name,all_time_rank_by_listening_time:index+1,metrics:{selected_period:metrics(cm.artists.get(x.key)),previous_period:metrics(pm.artists.get(x.key)),all_time:metrics(x)}}));
  const albums=all.albums.map((x,index)=>({album:x.name,artist:x.artist,all_time_rank_by_listening_time:index+1,metrics:{selected_period:metrics(cm.albums.get(x.key)),previous_period:metrics(pm.albums.get(x.key)),all_time:metrics(x)}}));
  return {tracks,artists,albums};
}
function momentum(current,previous,kind){
  if(!previous)return null;
  const a=new Map(current.map(x=>[x.key,x])),b=new Map(previous.map(x=>[x.key,x]));
  return [...new Set([...a.keys(),...b.keys()])].map(key=>{
    const c=a.get(key),p=b.get(key),identity=c||p;
    return {
      ...(kind==='tracks'?{track_uri:identity.uri||null,track:identity.name,artist:identity.artist,album:identity.album}:{artist:identity.name}),
      current:counts(c),previous:counts(p),
      change:{all_events:(c?.events||0)-(p?.events||0),gte_30_seconds:(c?.plays_30s||0)-(p?.plays_30s||0),gte_60_seconds:(c?.plays_60s||0)-(p?.plays_60s||0)},
      listening_minutes_change:round(((c?.ms||0)-(p?.ms||0))/60000)
    };
  }).sort((x,y)=>Math.abs(y.change.gte_30_seconds)-Math.abs(x.change.gte_30_seconds)||Math.abs(y.listening_minutes_change)-Math.abs(x.listening_minutes_change)||String(x.track||x.artist).localeCompare(String(y.track||y.artist)));
}
function makeLocalizer(timezone){
  const dateFmt=new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  const hourFmt=new Intl.DateTimeFormat('en-US',{timeZone:timezone,hour:'2-digit',hourCycle:'h23'});
  const weekdayFmt=new Intl.DateTimeFormat('en-US',{timeZone:timezone,weekday:'long'});
  return t=>{const d=new Date(t);return {date:dateFmt.format(d),hour:Number(hourFmt.format(d)),weekday:weekdayFmt.format(d)};};
}
function eventRecord(e,metadata,localize,now){
  const r=metadataFor(e,metadata,now,false),local=localize(e.t),raw=r?e.ms/r.duration_ms:null,capped=raw===null?null:Math.min(raw,1);
  return {
    ended_at_utc:iso(e.t),local_date:local.date,local_hour:local.hour,local_weekday:local.weekday,
    ms_played:e.ms,track_uri:e.uri||null,spotify_track_id:spotifyID(e.uri),track:e.name,artist:e.artist,album:e.album,
    skipped:e.skip,platform:e.platform||null,reason_start:e.start||null,reason_end:e.end||null,country:e.country||null,
    shuffle:typeof e.shuffle==='boolean'?e.shuffle:null,offline:typeof e.offline==='boolean'?e.offline:null,
    incognito:typeof e.incognito==='boolean'?e.incognito:null,offline_timestamp:e.offlineTimestamp??null,
    duration_ms:r?.duration_ms??null,duration_source:r?.source||null,
    completion_ratio_raw:raw===null?null:round(raw,6),completion_ratio_capped:capped===null?null:round(capped,6),
    full_listen:capped===null?null:capped>=.90,near_complete:capped===null?null:capped>=.75,early_exit:capped===null?null:capped<.25,
    exceeded_track_duration:raw===null?null:raw>1
  };
}
function groupedSummary(groups,timezone,metadata,now){
  return [...groups.entries()].sort(([a],[b])=>String(a).localeCompare(String(b))).map(([key,rows])=>{
    const a=aggregate(rows,-Infinity,Infinity,0,timezone,metadata,{now});
    return {key,...metrics(a),unique_tracks:a.tracks.length,unique_artists:a.artists.length};
  });
}
function timeSeries(events,timezone,metadata,now,localize){
  const daily=new Map(),hour=new Map(),weekday=new Map();
  for(const e of events){
    const p=localize(e.t);
    if(!daily.has(p.date))daily.set(p.date,[]);daily.get(p.date).push(e);
    if(!hour.has(p.hour))hour.set(p.hour,[]);hour.get(p.hour).push(e);
    if(!weekday.has(p.weekday))weekday.set(p.weekday,[]);weekday.get(p.weekday).push(e);
  }
  const hours=groupedSummary(hour,timezone,metadata,now).map(x=>({hour:Number(x.key),...Object.fromEntries(Object.entries(x).filter(([k])=>k!=='key'))})).sort((a,b)=>a.hour-b.hour);
  const order=['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
  const weekdays=groupedSummary(weekday,timezone,metadata,now).map(x=>({weekday:x.key,...Object.fromEntries(Object.entries(x).filter(([k])=>k!=='key'))})).sort((a,b)=>order.indexOf(a.weekday)-order.indexOf(b.weekday));
  return {daily:groupedSummary(daily,timezone,metadata,now).map(x=>({date:x.key,...Object.fromEntries(Object.entries(x).filter(([k])=>k!=='key'))})),hour_of_day:hours,weekday:weekdays};
}
function sourceCounts(events,metadata,now){
  const tracks={},eventSources={},context={platform:0,reason_start:0,reason_end:0,country:0,shuffle:0,offline:0,incognito:0,offline_timestamp:0};
  let eventWithId=0;const seen=new Set();
  for(const e of events){
    if(spotifyID(e.uri))eventWithId++;
    if(e.platform&&e.platform!=='Unknown')context.platform++;if(e.start)context.reason_start++;if(e.end)context.reason_end++;if(e.country)context.country++;
    if(typeof e.shuffle==='boolean')context.shuffle++;if(typeof e.offline==='boolean')context.offline++;if(typeof e.incognito==='boolean')context.incognito++;if(e.offlineTimestamp!==null&&e.offlineTimestamp!==undefined)context.offline_timestamp++;
    const k=trackKey(e);if(!seen.has(k)){seen.add(k);const r=metadataFor(e,metadata,now,false);if(r)tracks[r.source||'legacy_unknown']=(tracks[r.source||'legacy_unknown']||0)+1;}
    const r=metadataFor(e,metadata,now,false);if(r)eventSources[r.source||'legacy_unknown']=(eventSources[r.source||'legacy_unknown']||0)+1;
  }
  return {duration_tracks_by_source:tracks,duration_events_by_source:eventSources,events_with_spotify_track_id:eventWithId,event_field_coverage:Object.fromEntries(Object.entries(context).map(([k,v])=>[k,{known_events:v,coverage:events.length?round(v/events.length):null}]))};
}
export function buildProfile(events,metadata,q,demo=false,now=Date.now()){
  const r=periodRange(events,q),windows={},options={now};
  const compute=(from,to)=>aggregate(events,from,to,0,q.timezone,metadata,options);
  for(const days of [7,30,90,180]){const from=r.latest-days*86400000+1;windows['last_'+days+'_days']=periodSummary(compute(from,r.latest),from,r.latest);}
  const allRange=periodRange(events,{range:'all'}),all=compute(allRange.from,allRange.to),current=compute(r.from,r.to),previous=q.range==='all'?null:compute(r.previousFrom,r.previousTo);
  const localize=makeLocalizer(q.timezone);
  const historyEvents=[...events].sort((a,b)=>a.t-b.t).map(e=>eventRecord(e,metadata,localize,now));
  const sources=sourceCounts(events,metadata,now);
  return {
    schema_version:3,export_type:'listening_atlas_analysis',generated_at_utc:new Date(now).toISOString(),demo,
    history:{event_count:events.length,first_playback_end_utc:iso(allRange.from),latest_playback_end_utc:iso(r.latest),display_timezone:q.timezone,ui_play_threshold_ms:q.threshold,music_only:true},
    definitions,
    data_quality:{...all.coverage,skip_flag_known_events:all.known,skip_flag_coverage:all.events?round(all.known/all.events):null,...sources},
    periods:{selected:periodSummary(current,r.from,r.to),previous:previous?periodSummary(previous,r.previousFrom,r.previousTo):null,...windows,all_time:periodSummary(all,allRange.from,allRange.to)},
    entities:fullEntities(all,current,previous,metadata,now),
    momentum:previous?{tracks:momentum(current.tracks,previous.tracks,'tracks'),artists:momentum(current.artists,previous.artists,'artists')}:null,
    time_series:timeSeries(events,q.timezone,metadata,now,localize),
    events:historyEvents,
    unavailable:['liked_status','playlist_membership','playlist_name_or_uri','exact_start_time','audio_features','lyrics','artwork'],
    omitted_for_privacy_or_irrelevance:['ip_address','decrypted_user_agent','credentials','raw_spotify_api_responses']
  };
}
