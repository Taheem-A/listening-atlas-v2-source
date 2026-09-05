import {handleAPI} from './api.js';
import {assets} from './assets.generated.js';
export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if(url.pathname.startsWith('/api/'))return handleAPI(request,env);
    const asset=assets[url.pathname==='/'?'/index.html':url.pathname];
    if(!asset)return new Response('Not found',{status:404});
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405});
    return new Response(request.method==='HEAD'?null:asset.body,{headers:{'Content-Type':asset.type,'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'same-origin','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'"}});
  }
};
