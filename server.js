const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;

function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}
function json(res, status, data) { send(res, status, JSON.stringify(data)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data='';
    req.on('data', c => { data += c; if (data.length > 2_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch(e) { reject(new Error('JSON inválido')); } });
    req.on('error', reject);
  });
}
function openaiText(data) {
  if (typeof data.output_text === 'string') return data.output_text;
  let out='';
  for (const item of (data.output || [])) {
    for (const c of (item.content || [])) if (typeof c.text === 'string') out += c.text;
  }
  return out.trim();
}
function openaiSources(data) {
  const out=[];
  for (const item of (data.output || [])) for (const c of (item.content || [])) {
    for (const a of (c.annotations || [])) {
      if (a && a.type === 'url_citation' && a.url) out.push({title:a.title || a.url, url:a.url});
    }
  }
  return [...new Map(out.map(x=>[x.url,x])).values()];
}
function claudeText(data) {
  return (data.content || []).filter(x=>x.type==='text').map(x=>x.text || '').join('\n').trim();
}
function claudeSources(data) {
  const out=[];
  for (const b of (data.content || [])) {
    if (b.type === 'text' && Array.isArray(b.citations)) {
      for (const c of b.citations) if (c && c.url) out.push({title:c.title || c.url, url:c.url});
    }
  }
  return [...new Map(out.map(x=>[x.url,x])).values()];
}
function uniqueSources(out){ return [...new Map((out||[]).filter(x=>x&&x.url).map(x=>[x.url,x])).values()]; }
async function fetchText(url, options={}) {
  const r=await fetch(url,{...options,headers:{'User-Agent':'AI-Video-Studio-FLOW/27 (research)','Accept':'text/xml,application/xml,text/html,application/json;q=0.9,*/*;q=0.8',...(options.headers||{})}});
  if(!r.ok) throw new Error(`HTTP ${r.status} al consultar ${url}`);
  return await r.text();
}
function stripXml(s){ return String(s||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim(); }
function xmlTag(block, tag){ const m=block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`,'i')); return m?stripXml(m[1]):''; }
async function freeWebResearch(topic){
  const sources=[];
  const q=encodeURIComponent(String(topic).trim());
  // Google News RSS: no API key required; returns current articles and their URLs.
  try{
    const xml=await fetchText(`https://news.google.com/rss/search?q=${q}&hl=es-419&gl=EC&ceid=EC:es-419`);
    const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0,8).map(m=>m[1]);
    for(const b of items){
      const title=xmlTag(b,'title'); const link=xmlTag(b,'link'); const desc=xmlTag(b,'description'); const pub=xmlTag(b,'pubDate');
      if(link) sources.push({title:title||link,url:link,snippet:desc,published:pub});
    }
  }catch(e){ console.warn('Google News research:',e.message); }
  // Wikipedia API: useful for historical/background context without an API key.
  try{
    const data=JSON.parse(await fetchText(`https://es.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrlimit=3&prop=extracts&exintro=1&explaintext=1&format=json&origin=*`));
    for(const page of Object.values(data?.query?.pages||{})){
      if(page?.fullurl || page?.title) sources.push({title:`Wikipedia: ${page.title}`,url:page.fullurl||`https://es.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g,'_'))}`,snippet:String(page.extract||'').slice(0,900)});
    }
  }catch(e){ console.warn('Wikipedia research:',e.message); }
  return uniqueSources(sources).slice(0,10);
}
function researchPack(sources){
  if(!sources.length) return 'No se encontraron fuentes externas automáticamente. Si no puedes verificar un dato, indícalo como no confirmado.';
  return sources.map((s,i)=>`FUENTE ${i+1}\nTítulo: ${s.title}\nURL: ${s.url}\nExtracto: ${s.snippet||'Sin extracto disponible'}\n`).join('\n');
}

function keyFor(provider){
  const map={openrouter:'OPENROUTER_API_KEY',gemini:'GEMINI_API_KEY',openai:'OPENAI_API_KEY',claude:'ANTHROPIC_API_KEY'};
  return process.env[map[provider]] || '';
}
function providerLabel(p){ return ({openrouter:'OpenRouter gratis',gemini:'Google Gemini',openai:'OpenAI / ChatGPT',claude:'Anthropic / Claude'})[p] || p; }
async function callOpenRouter(model, prompt){
  const key=process.env.OPENROUTER_API_KEY;
  if(!key) throw new Error('Falta OPENROUTER_API_KEY.');
  const r=await fetch('https://openrouter.ai/api/v1/chat/completions',{
    method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json','HTTP-Referer':'https://ai-video-studio-flow-2.onrender.com','X-Title':'AI Video Studio FLOW'},
    body:JSON.stringify({model:model||'openrouter/free',messages:[{role:'user',content:prompt}],temperature:0.7,max_tokens:6000})
  });
  const data=await r.json();
  if(!r.ok) throw new Error(data?.error?.message||`OpenRouter HTTP ${r.status}`);
  const text=data?.choices?.[0]?.message?.content||'';
  if(!text.trim()) throw new Error('OpenRouter no devolvió texto.');
  return {text:text.trim(),sources:[],raw:data};
}
async function callGemini(model,prompt){
  const key=process.env.GEMINI_API_KEY;
  if(!key) throw new Error('Falta GEMINI_API_KEY.');
  const mdl=model||'gemini-3.8-flash';
  const url=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(mdl)}:generateContent?key=${encodeURIComponent(key)}`;
  const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{role:'user',parts:[{text:prompt}]}],tools:[{google_search:{}}],generationConfig:{temperature:0.7,maxOutputTokens:6000}})});
  const data=await r.json();
  if(!r.ok) throw new Error(data?.error?.message||`Gemini HTTP ${r.status}`);
  const text=(data?.candidates?.[0]?.content?.parts||[]).filter(x=>typeof x.text==='string').map(x=>x.text).join('\n').trim();
  if(!text) throw new Error('Gemini no devolvió texto.');
  const sources=[];
  const chunks=data?.candidates?.[0]?.groundingMetadata?.groundingChunks||[];
  for(const ch of chunks){ const w=ch?.web; if(w?.uri) sources.push({title:w.title||w.uri,url:w.uri}); }
  return {text,sources:uniqueSources(sources),raw:data};
}
async function callOpenAI(model,prompt) {
  const key=process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Falta OPENAI_API_KEY.');
  const r = await fetch('https://api.openai.com/v1/responses', {method:'POST',headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:model||'gpt-5.6-luna',tools:[{type:'web_search'}],input:prompt})});
  const data=await r.json(); if(!r.ok) throw new Error(data?.error?.message||`OpenAI HTTP ${r.status}`);
  return {text:openaiText(data),sources:openaiSources(data),raw:data};
}
async function callClaude(model,prompt) {
  const key=process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model:model||'claude-sonnet-4-6',max_tokens:6000,tools:[{type:'web_search_20250305',name:'web_search',max_uses:5}],messages:[{role:'user',content:prompt}]})});
  const data=await r.json(); if(!r.ok) throw new Error(data?.error?.message||`Claude HTTP ${r.status}`);
  return {text:claudeText(data),sources:claudeSources(data),raw:data};
}
async function callProvider(provider,model,prompt){
  if(provider==='openrouter') return callOpenRouter(model,prompt);
  if(provider==='gemini') return callGemini(model,prompt);
  if(provider==='openai') return callOpenAI(model,prompt);
  if(provider==='claude') return callClaude(model,prompt);
  throw new Error(`Proveedor no soportado: ${provider}`);
}
function providerOrder(requested){
  const all=['openrouter','gemini','openai','claude'];
  if(requested && requested!=='auto') return [requested];
  return all.filter(p=>!!keyFor(p));
}
async function main() {
  const server=http.createServer(async (req,res)=>{
    if(req.method==='OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}); return res.end(); }
    if(req.method==='GET' && req.url==='/health') return json(res,200,{ok:true,service:'AI Video Studio FLOW',version:'27.0',providers:{openrouter:!!keyFor('openrouter'),gemini:!!keyFor('gemini'),openai:!!keyFor('openai'),claude:!!keyFor('claude')}});
    if(req.method==='POST' && req.url==='/api/research') {
      try {
        const body=await readBody(req);
        const requested=String(body.provider||'auto');
        const prompt=String(body.prompt||'').trim();
        if(!prompt) return json(res,400,{error:'Falta el prompt de investigación.'});
        const order=providerOrder(requested);
        if(!order.length) return json(res,500,{error:'No hay ningún motor configurado. Añade OPENROUTER_API_KEY (recomendado gratis) o GEMINI_API_KEY en Render → Environment.'});
        const errors=[];
        // V27: búsqueda web independiente y sin API key para que OpenRouter también reciba fuentes/URLs.
        let externalSources=[];
        try { externalSources=await freeWebResearch(String(body.topic||body.search||'')); } catch(e) { console.warn('Free web research:',e.message); }
        const enrichedPrompt = externalSources.length ? `${prompt}\n\nINVESTIGACIÓN WEB PREVIA (fuentes recuperadas automáticamente):\n${researchPack(externalSources)}\n\nUsa estas fuentes como punto de partida. No inventes URLs ni afirmes que una fuente dice algo que no aparece en su extracto. Si hay contradicciones, señálalas.` : prompt;
        for(const provider of order){
          try{
            let model=String(body.model||'').trim();
            if(provider==='openrouter' && (requested==='auto' || !model || model.includes('gpt-') || model.includes('claude') || model.startsWith('gemini'))) model='openrouter/free';
            if(provider==='gemini' && (requested==='auto' || !model || model==='openrouter/free' || model.startsWith('gpt-') || model.includes('claude'))) model='gemini-3.8-flash';
            if(provider==='openai' && !model) model='gpt-5.6-luna';
            if(provider==='claude' && !model) model='claude-sonnet-4-6';
            const result=await callProvider(provider,model,enrichedPrompt);
            return json(res,200,{ok:true,version:'27.0',provider,providerLabel:providerLabel(provider),model,text:result.text,sources:uniqueSources([...(externalSources||[]),...(result.sources||[])]),fallbacksTried:errors.map(x=>x.provider),webSearch:{ok:externalSources.length>0,count:externalSources.length}});
          }catch(e){
            errors.push({provider,message:e.message||'Error'});
            console.error(`${provider}:`,e.message);
          }
        }
        const details=errors.map(x=>`${providerLabel(x.provider)}: ${x.message}`).join(' | ');
        return json(res,502,{error:`Todos los motores configurados fallaron. ${details}`,attempts:errors});
      } catch(e) { console.error(e); return json(res,500,{error:e.message || 'Error interno del servidor'}); }
    }
    if(req.method==='GET') {
      const file = req.url==='/' ? path.join(ROOT,'index.html') : path.join(ROOT,req.url.replace(/^\//,''));
      if(file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(res,200,fs.readFileSync(file), file.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream');
    }
    return json(res,404,{error:'Ruta no encontrada'});
  });
  server.listen(PORT,'0.0.0.0',()=>console.log(`AI Video Studio FLOW V27 escuchando en ${PORT}`));
}
main();
