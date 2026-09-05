import {spotifyID,metadataRecord} from './engine.js';
export class Enrichment {
  constructor({getMetadata,apply,onState,fetcher=(...args)=>fetch(...args),clock=Date.now}){Object.assign(this,{getMetadata,apply,onState,fetcher,clock});this.generation=0;this.active=false;this.state={state:'checking',cache:{}};this.timer=null;}
  cancel(){this.generation++;this.active=false;clearTimeout(this.timer);this.controller?.abort();}
  async status(){try{const r=await this.fetcher('/api/spotify/status',{credentials:'same-origin',cache:'no-store'});if(!r.ok)throw Error();this.state=await r.json();}catch{this.state={state:'temporary_error',cache:{}};}this.onState(this.state);return this.state;}
  async post(action,ids){
    this.controller=new AbortController();const timer=setTimeout(()=>this.controller.abort(),100000);
    try{
      let response;
      try{response=await this.fetcher('/api/spotify/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Atlas-Request':'metadata'},body:JSON.stringify({ids}),signal:this.controller.signal});}
      catch(error){if(error.name==='AbortError')throw error;throw Object.assign(Error('network_error'),{category:'network_error',stage:action});}
      let data;try{data=await response.json()}catch{}
      if(!response.ok)throw Object.assign(Error(data?.state||'http_error'),{category:data?.state||'http_error',httpStatus:response.status,stage:action});
      if(!data||typeof data.state!=='string'||(data.records&&!Array.isArray(data.records)))throw Object.assign(Error('invalid_response'),{category:'invalid_response',httpStatus:response.status,stage:action});
      return data;
    }finally{clearTimeout(timer);}
  }
  async run(rawIDs,{fetchMissing=false}={}){
    this.cancel();const generation=this.generation,ids=[...new Set(rawIDs.filter(id=>spotifyID(id)))];
    const config=await this.status();if(generation!==this.generation||config.state!=='ready')return;
    this.active=true;this.state={...config,state:'enriching'};this.onState(this.state);
    const missing=()=>ids.filter(id=>!metadataRecord(this.getMetadata()[id],id,this.clock()));
    const publish=extra=>{this.state={...this.state,...extra,total:ids.length,enriched:ids.length-missing().length};this.onState(this.state);};
    try{
      let needed=missing();
      for(let i=0;i<needed.length;i+=1000){if(generation!==this.generation)return;const r=await this.post('lookup',needed.slice(i,i+1000));if(generation!==this.generation)return;if(r.state!=='ready'){publish(r);return;}await this.apply(r.records||[]);publish({});}
      if(fetchMissing){let remaining=missing();
        for(let pass=0;pass<3&&remaining.length;pass++){
          let retryAt=0;
          for(let i=0;i<remaining.length;i+=8){
            if(generation!==this.generation)return;
            const batch=remaining.slice(i,i+8).filter(id=>{const r=this.getMetadata()[id];return !r||!(r.attempts>=3||['unavailable','identity_mismatch','invalid_metadata'].includes(r.metadata_status));});
            if(!batch.length)continue;
            const r=await this.post('enrich',batch);if(generation!==this.generation)return;await this.apply(r.records||[]);publish({});
            if(['rate_limited','busy'].includes(r.state)){
              publish({state:r.state,retry_at:r.retry_at});const wait=Math.max(1000,(r.retry_at||this.clock()+60000)-this.clock());
              // Long cooldowns require a deliberate resume; no permanent polling.
              if(wait>300000)return;
              this.timer=setTimeout(()=>{if(generation===this.generation)this.run(ids,{fetchMissing:true})},wait);return;
            }
            if(r.state!=='ready'){publish({state:r.state,retry_at:r.retry_at});return;}
            for(const item of r.records||[])if(item.metadata_status==='temporary_error'&&item.attempts<3)retryAt=Math.max(retryAt,item.retry_at);
          }
          remaining=missing().filter(id=>{const r=this.getMetadata()[id];return !r||(r.metadata_status==='temporary_error'&&r.attempts<3)});
          if(remaining.length&&retryAt>this.clock()){publish({state:'temporary_error',retry_at:retryAt});return;}
        }
      }
      publish({state:missing().length?'partially_enriched':'complete',retry_at:0});
    }catch(error){if(generation===this.generation&&error.name!=='AbortError'){
      const detail={state:error.category||'temporary_error',error_stage:error.stage||null,http_status:error.httpStatus||null};
      console.warn('Listening Atlas metadata request failed',detail);publish(detail);
    }}
    finally{if(generation===this.generation)this.active=false;}
  }
}
