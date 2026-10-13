import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SpotifyClient,SpotifyFailure} from '../server/spotify.js';

const ID='72DnQlaqdNhz9QJZXfYe6L';
const env={SPOTIFY_CLIENT_ID:'TEST_ID',SPOTIFY_CLIENT_SECRET:'TEST_SECRET'};
const token=()=>Response.json({access_token:'TEST_TOKEN',token_type:'Bearer',expires_in:3600});

test('track 429 surfaces quota_exceeded when Spotify provides QUOTA_EXCEEDED',async()=>{
  const client=new SpotifyClient(env,{fetcher:async url=>url.includes('/api/token')?token():Response.json({reason:'QUOTA_EXCEEDED'},{status:429,headers:{'Retry-After':'120'}}),clock:()=>1000});
  await assert.rejects(()=>client.track(ID),error=>error instanceof SpotifyFailure&&error.status==='rate_limited'&&error.reason==='quota_exceeded'&&error.httpStatus===429&&error.retryAt===121000);
});

test('generic 429 remains a normal rate limit when no quota reason is present',async()=>{
  const client=new SpotifyClient(env,{fetcher:async url=>url.includes('/api/token')?token():new Response('',{status:429,headers:{'Retry-After':'60'}}),clock:()=>1000});
  await assert.rejects(()=>client.track(ID),error=>error instanceof SpotifyFailure&&error.status==='rate_limited'&&error.reason===null&&error.retryAt===61000);
});
