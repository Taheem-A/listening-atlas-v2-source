import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpotifyClient,SpotifyFailure} from '../server/spotify.js';
import {Enrichment} from '../public/enrichment.js';

const env={SPOTIFY_CLIENT_ID:'TEST_ID',SPOTIFY_CLIENT_SECRET:'TEST_SECRET',SPOTIFY_ANALYTICS_PERMISSION:'granted'};
const ID='72DnQlaqdNhz9QJZXfYe6L';

test('hosted fetch uses normal redirect behavior and preserves only safe network diagnostics',async()=>{
  let tokenOptions;
  const client=new SpotifyClient(env,{fetcher:async(url,options)=>{
    if(url.includes('/api/token')){
      tokenOptions=options;
      const error=new TypeError('sensitive runtime text TEST_SECRET');
      error.cause={code:'ECONNRESET'};
      throw error;
    }
    return new Response('',{status:204});
  }});
  await assert.rejects(()=>client.track(ID),error=>{
    assert.ok(error instanceof SpotifyFailure);
    assert.equal(error.stage,'token');
    assert.equal(error.reason,'network_error');
    assert.equal(error.errorName,'TypeError');
    assert.equal(error.errorCode,'ECONNRESET');
    assert.equal(error.message.includes('TEST_SECRET'),false);
    return true;
  });
  assert.equal('redirect' in tokenOptions,false);
});

test('network diagnostics distinguish general HTTPS from Spotify Accounts reachability',async()=>{
  const client=new SpotifyClient(env,{fetcher:async url=>{
    if(url==='https://example.com/')return new Response('',{status:200});
    if(url==='https://accounts.spotify.com/'){
      const error=new TypeError('private message');error.cause={code:'ENOTFOUND'};throw error;
    }
    throw new Error('unexpected URL');
  }});
  const result=await client.diagnostics();
  assert.deepEqual(result.general_https,{ok:true,http_status:200});
  assert.equal(result.spotify_accounts.ok,false);
  assert.equal(result.spotify_accounts.reason,'network_error');
  assert.equal(result.spotify_accounts.error_name,'TypeError');
  assert.equal(result.spotify_accounts.error_code,'ENOTFOUND');
  assert.equal(JSON.stringify(result).includes('private message'),false);
});

test('browser diagnostic state renders probe results without raw upstream details',()=>{
  const manager=new Enrichment({getMetadata:()=>({}),apply:async()=>{},onState:()=>{}});
  const state=manager.diagnosticState({
    state:'temporary_error',retry_at:123,
    upstream_stage:'token',upstream_reason:'network_error',upstream_error_name:'TypeError',upstream_error_code:'ECONNRESET',
    network_probes:{general_https:{ok:true,http_status:200},spotify_accounts:{ok:false,error_name:'TypeError',error_code:'ENOTFOUND'}}
  });
  assert.equal(state.state,'temporary_error');
  assert.equal(state.upstream_stage,null);
  assert.match(state.error_stage,/Spotify token/);
  assert.match(state.error_stage,/network error/);
  assert.match(state.error_stage,/HTTPS probe reachable HTTP 200/);
  assert.match(state.error_stage,/Spotify host failed TypeError ENOTFOUND/);
});
