import {defineConfig} from 'vite';
import {readFile} from 'node:fs/promises';
import {handleAPI} from './server/api.js';
// Internal preview uses the same frontend and API handler, with no credentials.
// It never reads production secrets or sends Spotify requests.
export default defineConfig({root:'public',publicDir:false,server:{host:'0.0.0.0',allowedHosts:['terminal.local']},plugins:[{name:'atlas-preview',configureServer(server){server.middlewares.use(async(req,res,next)=>{
 if(!req.url?.startsWith('/api/'))return next();
 try{let body='';for await(const chunk of req)body+=chunk;const headers=new Headers(req.headers);headers.set('oai-authenticated-user-id','local-preview-user');const request=new Request('http://'+req.headers.host+req.url,{method:req.method,headers,...(req.method==='POST'?{body}:{})});const response=await handleAPI(request,{});res.statusCode=response.status;response.headers.forEach((v,k)=>res.setHeader(k,v));res.end(await response.text());}catch{res.statusCode=503;res.end(JSON.stringify({state:'temporary_error'}));}
 });}}]});
