import {MetadataCache} from './cache.js';
import {SpotifyClient,SpotifyFailure,CACHE_TTL} from './spotify.js';
export const validID=id=>typeof id==='string'&&/^[A-Za-z0-9]{22}$/.test(id);
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
let sharedSpotifyClient=null;
// A Worker isolate serves one deployed Site configuration. Reusing one client keeps the
// client-credentials access token hot across short enrichment requests. Redeploying
// creates a fresh isolate/client when hosted environment values change.
function spotify(env){if(!sharedSpotifyClient)sharedSpotifyClient=new SpotifyClient(env);return sharedSpotifyClient}
export function configuration(env) {
  if(!env.SPOTIFY_CLIENT_ID||!env.SPOTIFY_CLIENT_SECRET)return 'not_configured';
  if(env.SPOTIFY_ANALYTICS_PERMISSION!=='granted')return 'permission_required';
  if(!env.DB)return 'storage_unavailable';
  return 'ready';
}
const failureDetails=failure=>({
  upstream_stage:failure.stage||null,
  upstream_status:Number.isInteger(failure.httpStatus)?failure.httpStatus:null,
  upstream_reason:failure.reason||null,
});
// One globally leased batch at a time. Keep hosted invocations short: at most three
// Spotify calls per request, paced one second apart. The browser honors retry_at before
// starting the next batch, while the D1 lease/cooldown protects across tabs/instances.
export async function enrich(ids,cache,client,{clock=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  const now=clock(),lock=crypto.randomUUID();
  if(!await cache.claim(now,lock)){const c=await cache.control();return {state:c?.next_request_at>now?'rate_limited':'busy',retry_at:Math.max(c?.next_request_at||0,now+2000),records:[]};}
  let next=now,records=[],state='ready',diagnostic={};
  try{
    const current=new Map((await cache.get(ids)).map(r=>[r.spotify_track_id,r]));
    for(let index=0;index<ids.length;index++){
      const id=ids[index],old=current.get(id);
      if(old&&old.expires_at>clock()&&(old.metadata_status==='ready'||['unavailable','identity_mismatch','invalid_metadata'].includes(old.metadata_status)||old.attempts>=3||old.retry_at>clock())){records.push(old);continue;}
      let fetched;
      try{fetched=await client.track(id)}catch(error){
        const failure=error instanceof SpotifyFailure?error:new SpotifyFailure('temporary_error',0,{stage:'spotify_client',reason:'unexpected_error'});
        state=failure.status;diagnostic=failureDetails(failure);
        if(['rate_limited','credentials_error','access_denied'].includes(state)){next=failure.retryAt||clock()+60000;break;}
        const attempts=(old?.attempts||0)+1;
        const row={spotify_track_id:id,duration_ms:null,metadata_status:'temporary_error',fetched_at:clock(),expires_at:clock()+CACHE_TTL,retry_at:clock()+Math.min(300000,15000*2**(attempts-1)),attempts};
        await cache.put(row);records.push(row);next=row.retry_at;break;
      }
      const row={spotify_track_id:id,duration_ms:fetched.duration,metadata_status:fetched.status,fetched_at:clock(),expires_at:clock()+CACHE_TTL,retry_at:0,attempts:0};
      await cache.put(row);records.push(row);next=clock()+1000;
      if(index<ids.length-1)await sleep(1000);
    }
    return {state,retry_at:next,records,...diagnostic};
  }finally{await cache.release(lock,next);}
}
export async function handleAPI(request,env,dependencies={}) {
  // Sites dispatch verifies these headers; there is no client-side auth or secret.
  if(!request.headers.get('oai-authenticated-user-id'))return json({state:'sign_in_required'},401);
  const url=new URL(request.url),path=url.pathname;
  if(request.method==='GET'&&path==='/api/spotify/status'){
    const state=configuration(env);
    let stats={tracks:0,enriched:0,last_enrichment:null};
    if(env.DB){try{const c=new MetadataCache(env.DB);await c.prune(Date.now());stats=await c.stats();}catch{return json({state:'storage_unavailable',cache:stats});}}
    return json({state,cache:stats,policy_url:'https://developer.spotify.com/policy',cache_ttl_days:30});
  }
  if(request.method!=='POST'||!['/api/spotify/lookup','/api/spotify/enrich'].includes(path))return json({state:'not_found'},404);
  if(request.headers.get('Origin')!==url.origin||request.headers.get('X-Atlas-Request')!=='metadata'||!request.headers.get('Content-Type')?.startsWith('application/json'))return json({state:'forbidden'},403);
  let text,body;
  try{const reader=request.body?.getReader();if(!reader)throw Error();let size=0,parts=[];while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();return json({state:'invalid_request'},413);}parts.push(value)}text=new TextDecoder().decode(await new Blob(parts).arrayBuffer());body=JSON.parse(text);}catch{return json({state:'invalid_request'},400);}
  const maximum=path==='/api/spotify/lookup'?1000:3;
  if(!body||Object.keys(body).some(k=>k!=='ids')||!Array.isArray(body.ids)||body.ids.length>maximum||!body.ids.every(validID))return json({state:'invalid_ids'},400);
  const ids=[...new Set(body.ids)];
  const state=configuration(env);
  if(state!=='ready')return json({state,records:[]});
  try{
    const cache=dependencies.cache||new MetadataCache(env.DB);await cache.prune(Date.now());
    if(path==='/api/spotify/lookup')return json({state:'ready',records:await cache.get(ids)});
    return json(await enrich(ids,cache,dependencies.client||spotify(env),dependencies));
  }catch(error){
    console.warn('Listening Atlas Spotify API handler failed',{stage:path.endsWith('/lookup')?'lookup':'enrich',category:error instanceof SpotifyFailure?error.status:'server_error'});
    return json({state:'temporary_error',records:[],retry_at:Date.now()+60000,error_stage:path.endsWith('/lookup')?'lookup_server':'enrich_server'},503);
  }
}
