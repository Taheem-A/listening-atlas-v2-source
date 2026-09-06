export const CACHE_TTL = 30 * 86400000;
export function retryAfter(value, now=Date.now()) {
  const seconds = value !== null && value !== '' ? Number(value) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return now + Math.max(1000,seconds*1000);
  const date=Date.parse(value); return Number.isFinite(date)&&date>now?date:now+60000;
}
export class SpotifyFailure extends Error {
  constructor(status,retryAt=0,{stage=null,httpStatus=null,reason=null}={}){
    super(status);this.status=status;this.retryAt=retryAt;this.stage=stage;this.httpStatus=httpStatus;this.reason=reason;
  }
}
export class SpotifyClient {
  constructor(env, {fetcher=(...args)=>fetch(...args),clock=Date.now}={}) {this.env=env;this.fetcher=fetcher;this.clock=clock;this.token=null;this.tokenUntil=0;this.pending=null;}
  async fetchTimed(url,options={},stage='upstream') {
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try {return await this.fetcher(url,{...options,signal:controller.signal,redirect:'error'});}
    catch {throw new SpotifyFailure('temporary_error',0,{stage,reason:controller.signal.aborted?'timeout':'network_error'});}
    finally {clearTimeout(timer);}
  }
  async accessToken(force=false) {
    if(force){this.token=null;this.tokenUntil=0;}
    if(this.token&&this.clock()<this.tokenUntil)return this.token;
    if(this.pending)return this.pending;
    this.pending=(async()=>{
      const response=await this.fetchTimed('https://accounts.spotify.com/api/token',{method:'POST',headers:{Authorization:'Basic '+btoa(this.env.SPOTIFY_CLIENT_ID+':'+this.env.SPOTIFY_CLIENT_SECRET),'Content-Type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'},'token');
      if(response.status===429)throw new SpotifyFailure('rate_limited',retryAfter(response.headers.get('Retry-After'),this.clock()),{stage:'token',httpStatus:429});
      if(response.status===400||response.status===401||response.status===403)throw new SpotifyFailure('credentials_error',0,{stage:'token',httpStatus:response.status});
      if(!response.ok)throw new SpotifyFailure('temporary_error',0,{stage:'token',httpStatus:response.status});
      let body;try{body=await response.json()}catch{throw new SpotifyFailure('temporary_error',0,{stage:'token_response',httpStatus:response.status,reason:'invalid_json'})}
      if(typeof body.access_token!=='string'||!body.access_token||!Number.isFinite(body.expires_in)||body.expires_in<=0||String(body.token_type).toLowerCase()!=='bearer')throw new SpotifyFailure('temporary_error',0,{stage:'token_response',httpStatus:response.status,reason:'invalid_payload'});
      this.token=body.access_token;this.tokenUntil=this.clock()+Math.max(0,body.expires_in*1000-60000);return this.token;
    })();
    try{return await this.pending}finally{this.pending=null;}
  }
  async track(id) {
    for(let attempt=0;attempt<2;attempt++){
      const token=await this.accessToken(attempt===1);
      const response=await this.fetchTimed('https://api.spotify.com/v1/tracks/'+id+'?market=CA',{headers:{Authorization:'Bearer '+token}},'track');
      if(response.status===401){if(attempt===0)continue;throw new SpotifyFailure('credentials_error',0,{stage:'track',httpStatus:401});}
      if(response.status===403)throw new SpotifyFailure('access_denied',0,{stage:'track',httpStatus:403});
      if(response.status===429)throw new SpotifyFailure('rate_limited',retryAfter(response.headers.get('Retry-After'),this.clock()),{stage:'track',httpStatus:429});
      if(response.status===400||response.status===404)return {status:'unavailable',duration:null};
      if(!response.ok)throw new SpotifyFailure('temporary_error',0,{stage:'track',httpStatus:response.status});
      let body;try{body=await response.json()}catch{throw new SpotifyFailure('temporary_error',0,{stage:'track_response',httpStatus:response.status,reason:'invalid_json'})}
      // Reject relinking: never silently assign a different recording's duration.
      if(body?.id!==id)return {status:'identity_mismatch',duration:null};
      if(body.type!=='track'||body.is_local===true||!Number.isSafeInteger(body.duration_ms)||body.duration_ms<=0||body.duration_ms>86400000) return {status:'invalid_metadata',duration:null};
      return {status:'ready',duration:body.duration_ms};
    }
  }
}
