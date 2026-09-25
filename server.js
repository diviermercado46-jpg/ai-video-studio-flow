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
async function callOpenAI(model, prompt) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('Falta OPENAI_API_KEY en Render → Environment Variables.');
  const r = await fetch('https://api.openai.com/v1/responses', {
    method:'POST',
    headers:{'Authorization':`Bearer ${key}`,'Content-Type':'application/json'},
    body:JSON.stringify({
      model: model || 'gpt-5.6-luna',
      tools:[{type:'web_search'}],
      input:prompt
    })
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `OpenAI HTTP ${r.status}`);
  return {text:openaiText(data), sources:openaiSources(data), raw:data};
}
async function callClaude(model, prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Falta ANTHROPIC_API_KEY en Render → Environment Variables.');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json','anthropic-dangerous-direct-browser-access':'false'},
    body:JSON.stringify({
      model:model || 'claude-sonnet-4-6',
      max_tokens:6000,
      tools:[{type:'web_search_20250305',name:'web_search',max_uses:5}],
      messages:[{role:'user',content:prompt}]
    })
  });
  const data=await r.json();
  if(!r.ok) throw new Error(data?.error?.message || `Claude HTTP ${r.status}`);
  return {text:claudeText(data), sources:claudeSources(data), raw:data};
}
async function main() {
  const server=http.createServer(async (req,res)=>{
    if(req.method==='OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'Content-Type','Access-Control-Allow-Methods':'GET,POST,OPTIONS'}); return res.end(); }
    if(req.method==='GET' && req.url==='/health') return json(res,200,{ok:true,service:'AI Video Studio FLOW',version:'24.1'});
    if(req.method==='POST' && req.url==='/api/research') {
      try {
        const body=await readBody(req);
        const provider=body.provider==='claude'?'claude':'openai';
        const prompt=String(body.prompt||'').trim();
        if(!prompt) return json(res,400,{error:'Falta el prompt de investigación.'});
        const result=provider==='claude' ? await callClaude(String(body.model||'claude-sonnet-4-6'),prompt) : await callOpenAI(String(body.model||'gpt-5.6-luna'),prompt);
        return json(res,200,{ok:true,provider,text:result.text,sources:result.sources});
      } catch(e) { console.error(e); return json(res,500,{error:e.message || 'Error interno del servidor'}); }
    }
    if(req.method==='GET') {
      const file = req.url==='/' ? path.join(ROOT,'index.html') : path.join(ROOT,req.url.replace(/^\//,''));
      if(file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(res,200,fs.readFileSync(file), file.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream');
    }
    return json(res,404,{error:'Ruta no encontrada'});
  });
  server.listen(PORT,'0.0.0.0',()=>console.log(`AI Video Studio FLOW 24.1 escuchando en ${PORT}`));
}
main();
