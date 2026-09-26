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
  const r=await fetch(url,{...options,headers:{'User-Agent':'AI-Video-Studio-FLOW/29 (research)','Accept':'text/xml,application/xml,text/html,application/json;q=0.9,*/*;q=0.8',...(options.headers||{})}});
  if(!r.ok) throw new Error(`HTTP ${r.status} al consultar ${url}`);
  return await r.text();
}
function stripXml(s){ return String(s||'').replace(/<[^>]*>/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim(); }
function xmlTag(block, tag){ const m=block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`,'i')); return m?stripXml(m[1]):''; }
function normText(s){
  return String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9ñáéíóúü\s-]/gi,' ').replace(/\s+/g,' ').trim();
}
function topicKeywords(topic){
  const stop=new Set(['el','la','los','las','un','una','unos','unas','de','del','al','y','o','en','por','para','con','sin','que','como','es','son','misterio','misterios','caso','casos','historia','historias','secreto','secretos','sobre','una','uno']);
  return [...new Set(normText(topic).split(/\s+/).filter(w=>w.length>=4 && !stop.has(w)))];
}
function sourceRelevance(source, keywords){
  const hay=normText(`${source.title||''} ${source.snippet||''}`);
  if(!hay || !keywords.length) return 0;
  let hits=0;
  for(const k of keywords){
    if(hay.includes(k)) hits++;
  }
  return hits / keywords.length;
}
function filterRelevantSources(sources, topic){
  const keywords=topicKeywords(topic);
  if(!keywords.length) return [];
  const scored=uniqueSources(sources).map(s=>({...s,relevance:sourceRelevance(s,keywords)}));
  // Require meaningful overlap with the actual topic. For a one-keyword topic, require that keyword.
  const threshold=keywords.length<=2 ? 0.5 : 0.34;
  return scored.filter(s=>s.relevance>=threshold).sort((a,b)=>b.relevance-a.relevance).slice(0,10).map(({relevance,...s})=>s);
}
async function freeWebResearch(topic){
  const raw=[];
  const cleanTopic=String(topic||'').trim();
  const keywords=topicKeywords(cleanTopic);
  if(!cleanTopic || !keywords.length) return [];
  const queries=[`"${cleanTopic}"`, keywords.join(' ')].filter((x,i,a)=>x && a.indexOf(x)===i);
  for(const query of queries){
    const q=encodeURIComponent(query);
    try{
      const xml=await fetchText(`https://news.google.com/rss/search?q=${q}&hl=es-419&gl=EC&ceid=EC:es-419`);
      const items=[...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0,10).map(m=>m[1]);
      for(const b of items){
        const title=xmlTag(b,'title'); const link=xmlTag(b,'link'); const desc=xmlTag(b,'description'); const pub=xmlTag(b,'pubDate');
        if(link) raw.push({title:title||link,url:link,snippet:desc,published:pub});
      }
    }catch(e){ console.warn('Google News research:',e.message); }
  }
  try{
    const q=encodeURIComponent(cleanTopic);
    const data=JSON.parse(await fetchText(`https://es.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${q}&gsrlimit=5&prop=extracts|info&inprop=url&exintro=1&explaintext=1&format=json&origin=*`));
    for(const page of Object.values(data?.query?.pages||{})){
      if(page?.fullurl || page?.title) raw.push({title:`Wikipedia: ${page.title}`,url:page.fullurl||`https://es.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g,'_'))}`,snippet:String(page.extract||'').slice(0,1200)});
    }
  }catch(e){ console.warn('Wikipedia research:',e.message); }
  return filterRelevantSources(raw,cleanTopic);
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
    if(req.method==='GET' && req.url==='/health') return json(res,200,{ok:true,service:'AI Video Studio FLOW',version:'31.0',providers:{openrouter:!!keyFor('openrouter'),gemini:!!keyFor('gemini'),openai:!!keyFor('openai'),claude:!!keyFor('claude')}});
    if(req.method==='POST' && req.url==='/api/research') {
      try {
        const body=await readBody(req);
        const requested=String(body.provider||'auto');
        const prompt=String(body.prompt||'').trim();
        const isReflectionMode=/(Categoría:\s*(Reflexión del día|Reflexiones|Motivación|Superación personal|Reflexión bíblica)|MODO REFLEXIÓN V31)/i.test(prompt);
        if(!prompt) return json(res,400,{error:'Falta el prompt de investigación.'});
        const order=providerOrder(requested);
        if(!order.length) return json(res,500,{error:'No hay ningún motor configurado. Añade OPENROUTER_API_KEY (recomendado gratis) o GEMINI_API_KEY en Render → Environment.'});
        const errors=[];
        // V27: búsqueda web independiente y sin API key para que OpenRouter también reciba fuentes/URLs.
        let externalSources=[];
        // V31: las reflexiones no deben contaminarse con personajes, fechas o historias externas.
        if(!isReflectionMode){
          try { externalSources=await freeWebResearch(String(body.topic||body.search||'')); } catch(e) { console.warn('Free web research:',e.message); }
        }
        const sourceRules = `\n\nREGLAS V31 DE TRAZABILIDAD:\n- Usa únicamente la información que aparezca en los extractos de las fuentes proporcionadas o que puedas presentar claramente como contexto general no verificado.\n- No inventes hechos, fechas, cifras, testimonios ni URLs.\n- Cada afirmación factual importante debe quedar respaldada en la sección DATOS Y FUENTES mediante uno o más números de fuente, por ejemplo: [Fuente 1].\n- Distingue explícitamente HECHO DOCUMENTADO, HIPÓTESIS, TEORÍA o DATO NO CONFIRMADO cuando corresponda.\n- Si dos fuentes difieren, indícalo en DATOS Y FUENTES y no elijas una versión como cierta sin respaldo.\n- El GUION debe ser narración natural, sin etiquetas [Fuente X] dentro del texto.\n- Después del GUION incluye una sección DATOS Y FUENTES con una lista de las afirmaciones factuales principales y sus fuentes.\n- Formato obligatorio: TÍTULO, RESUMEN, HECHOS CLAVE, GUION, DATOS Y FUENTES.`;
const reflectionRules = isReflectionMode ? `\n\nREGLAS V31 — MODO REFLEXIÓN: No uses ninguna fuente externa en el GUION. No menciones personas reales, libros, fechas, noticias, estudios o citas salvo que el usuario los haya solicitado expresamente. No fabriques historias para hacer el texto más interesante. Escribe una reflexión original, humana y emocional basada únicamente en el tema dado. En DATOS Y FUENTES escribe exactamente: “No se utilizaron fuentes externas; reflexión creativa.”` : '';
        const enrichedPrompt = externalSources.length ? `${prompt}${sourceRules}${reflectionRules}\n\nINVESTIGACIÓN WEB PREVIA (fuentes recuperadas automáticamente):\n${researchPack(externalSources)}\n\nUsa estas fuentes como punto de partida. No inventes URLs ni afirmes que una fuente dice algo que no aparece en su extracto. Si hay contradicciones, señálalas.` : `${prompt}${sourceRules}${reflectionRules}`;
        for(const provider of order){
          try{
            let model=String(body.model||'').trim();
            if(provider==='openrouter' && (requested==='auto' || !model || model.includes('gpt-') || model.includes('claude') || model.startsWith('gemini'))) model='openrouter/free';
            if(provider==='gemini' && (requested==='auto' || !model || model==='openrouter/free' || model.startsWith('gpt-') || model.includes('claude'))) model='gemini-3.8-flash';
            if(provider==='openai' && !model) model='gpt-5.6-luna';
            if(provider==='claude' && !model) model='claude-sonnet-4-6';
            const result=await callProvider(provider,model,enrichedPrompt);
            return json(res,200,{ok:true,version:'31.0',provider,providerLabel:providerLabel(provider),model,text:result.text,sources:uniqueSources([...(externalSources||[]),...(result.sources||[])]),fallbacksTried:errors.map(x=>x.provider),webSearch:{ok:externalSources.length>0,count:externalSources.length}});
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
  server.listen(PORT,'0.0.0.0',()=>console.log(`AI Video Studio FLOW V29 escuchando en ${PORT}`));
}
main();
