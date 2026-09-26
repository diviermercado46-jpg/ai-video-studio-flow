const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 10000);
const ROOT = __dirname;
const DEFAULT_MODEL = 'gemini-3.5-flash-lite';

function send(res, status, body, type='application/json; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(body);
}
function json(res, status, data) { send(res, status, JSON.stringify(data)); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data='';
    req.on('data', c => {
      data += c;
      if (data.length > 2_000_000) { req.destroy(); reject(new Error('Solicitud demasiado grande.')); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch(e) { reject(new Error('JSON inválido')); }
    });
    req.on('error', reject);
  });
}

function geminiText(data) {
  return (data?.candidates || [])
    .flatMap(c => c?.content?.parts || [])
    .map(p => p?.text || '')
    .join('\n')
    .trim();
}

function geminiSources(data) {
  const out=[];
  for (const c of (data?.candidates || [])) {
    const gm = c?.groundingMetadata;
    for (const chunk of (gm?.groundingChunks || [])) {
      const web = chunk?.web;
      if (web?.uri) out.push({title:web.title || web.uri, url:web.uri});
    }
    for (const support of (gm?.groundingSupports || [])) {
      for (const idx of (support?.groundingChunkIndices || [])) {
        const chunk = gm?.groundingChunks?.[idx]?.web;
        if (chunk?.uri) out.push({title:chunk.title || chunk.uri, url:chunk.uri});
      }
    }
  }
  return [...new Map(out.map(x=>[x.url,x])).values()];
}

async function callGemini(model, prompt, searchMode) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('Falta GEMINI_API_KEY en Render → Environment Variables.');
  const selectedModel = String(model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const useSearch = searchMode !== 'off';
  const body = {
    contents: [{ role:'user', parts:[{text:prompt}] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 7000 }
  };
  if (useSearch) body.tools = [{ google_search: {} }];

  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selectedModel)}:generateContent`, {
    method:'POST',
    headers:{'x-goog-api-key':key,'Content-Type':'application/json'},
    body:JSON.stringify(body)
  });
  const data = await r.json();
  if (!r.ok) {
    const message = data?.error?.message || `Gemini HTTP ${r.status}`;
    throw new Error(message);
  }
  const text = geminiText(data);
  if (!text) throw new Error('Gemini no devolvió texto. Intenta de nuevo.');
  return {text, sources:geminiSources(data), raw:data};
}

async function main() {
  const server=http.createServer(async (req,res)=>{
    if(req.method==='OPTIONS') return send(res,204,'');
    if(req.method==='GET' && req.url==='/health') return json(res,200,{ok:true,service:'AI Video Studio FLOW',version:'25-gemini',provider:'gemini',model:DEFAULT_MODEL});

    if(req.method==='POST' && req.url==='/api/research') {
      try {
        const body=await readBody(req);
        const prompt=String(body.prompt||'').trim();
        if(!prompt) return json(res,400,{error:'Falta el prompt de investigación.'});
        const model=String(body.model||DEFAULT_MODEL).trim() || DEFAULT_MODEL;
        const search=String(body.search||'required');
        const result=await callGemini(model,prompt,search);
        return json(res,200,{ok:true,provider:'gemini',model,text:result.text,sources:result.sources});
      } catch(e) {
        console.error(e);
        return json(res,500,{error:e.message || 'Error interno del servidor'});
      }
    }

    if(req.method==='GET') {
      const requested = req.url.split('?')[0];
      const file = requested==='/' ? path.join(ROOT,'index.html') : path.join(ROOT,requested.replace(/^\//,''));
      if(file.startsWith(ROOT) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        const ext=path.extname(file).toLowerCase();
        const type=ext==='.html'?'text/html; charset=utf-8':ext==='.js'?'application/javascript; charset=utf-8':'application/octet-stream';
        return send(res,200,fs.readFileSync(file),type);
      }
    }
    return json(res,404,{error:'Ruta no encontrada'});
  });
  server.listen(PORT,'0.0.0.0',()=>console.log(`AI Video Studio FLOW Gemini escuchando en ${PORT}`));
}
main();
