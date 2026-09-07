import {spotifyID} from './engine.js';

// Rank exact Spotify IDs by how much of the imported history they represent.
// This lets limited API quota cover the most behaviorally important tracks first.
export function prioritizedSpotifyIDs(events) {
  const stats=new Map();
  for(const event of events){
    const id=spotifyID(event?.uri);if(!id)continue;
    let row=stats.get(id);if(!row){row={id,events:0,ms:0,last:0};stats.set(id,row);}
    row.events++;
    if(Number.isFinite(event.ms)&&event.ms>0)row.ms+=event.ms;
    if(Number.isFinite(event.t)&&event.t>row.last)row.last=event.t;
  }
  return [...stats.values()]
    .sort((a,b)=>b.events-a.events||b.ms-a.ms||b.last-a.last||a.id.localeCompare(b.id))
    .map(row=>row.id);
}
