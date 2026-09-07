import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prioritizedSpotifyIDs} from '../public/priority.js';

const A='AAAAAAAAAAAAAAAAAAAAAA';
const B='BBBBBBBBBBBBBBBBBBBBBB';
const C='CCCCCCCCCCCCCCCCCCCCCC';
const D='DDDDDDDDDDDDDDDDDDDDDD';
const e=(id,ms,t)=>({uri:'spotify:track:'+id,ms,t});

test('Spotify enrichment priority is events, then listening time, then recency, then ID',()=>{
  const events=[
    e(B,100,1),e(B,100,2),e(B,100,3),
    e(A,1000,1),e(A,1000,2),e(A,1000,3),
    e(C,5000,1),e(C,5000,2),
    e(D,5000,2),e(D,5000,3),
    {uri:'',ms:999999,t:999},
  ];
  assert.deepEqual(prioritizedSpotifyIDs(events),[A,B,D,C]);
});

test('Spotify enrichment priority deduplicates exact IDs and ignores non-track URIs',()=>{
  assert.deepEqual(prioritizedSpotifyIDs([
    e(A,100,1),e(A,200,2),{uri:'spotify:local:foo',ms:1,t:3},{uri:'bad',ms:1,t:4}
  ]),[A]);
});
