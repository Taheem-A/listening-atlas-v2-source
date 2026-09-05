import {readFile,writeFile,mkdir,readdir,cp} from 'node:fs/promises';
import {build} from 'esbuild';
const assets={};const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
for(const file of await readdir('public')){const ext=file.slice(file.lastIndexOf('.'));if(!types[ext])continue;assets['/'+file]={type:types[ext],body:await readFile('public/'+file,'utf8')}}
await writeFile('server/assets.generated.js','export const assets='+JSON.stringify(assets)+';\n');
await mkdir('dist/server',{recursive:true});
await build({entryPoints:['server/index.js'],outfile:'dist/server/index.js',bundle:true,format:'esm',platform:'browser',target:'es2022',minify:false});
await mkdir('dist/.openai',{recursive:true});
await cp('.openai/hosting.json','dist/.openai/hosting.json');
await cp('drizzle','dist/.openai/drizzle',{recursive:true});
console.log('Built existing frontend plus isolated metadata backend.');
