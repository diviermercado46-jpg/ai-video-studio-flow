
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 10000;
const upload = multer({ dest: path.join(os.tmpdir(), "aive4-uploads") });
app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req,res)=>res.json({
  ok:true,
  ffmpeg:true,
  semanticMode: !!process.env.OPENAI_API_KEY
}));

function run(cmd,args){
  return new Promise((resolve,reject)=>{
    const p=spawn(cmd,args,{stdio:["ignore","pipe","pipe"]});
    let out="", err="";
    p.stdout.on("data",d=>out+=d);
    p.stderr.on("data",d=>err+=d);
    p.on("close",code=>code===0?resolve(out):reject(new Error(err.slice(-5000)||("exit "+code))));
  });
}
function safeName(s){ return String(s||"file").replace(/[^a-zA-Z0-9._-]/g,"_"); }

app.post("/api/transcribe", upload.single("audio"), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:"Falta el audio."});
  if(!process.env.OPENAI_API_KEY){
    return res.status(503).json({
      error:"No hay OPENAI_API_KEY en el servidor. Puedes usar el modo de organización por palabras clave del nombre de las imágenes."
    });
  }
  try{
    // Use the official OpenAI REST endpoint directly, without exposing the key to the browser.
    const data = new FormData();
    const buf = fs.readFileSync(req.file.path);
    data.append("file", new Blob([buf]), safeName(req.file.originalname||"audio.webm"));
    data.append("model", "gpt-4o-mini-transcribe");
    const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method:"POST",
      headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
      body:data
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error?.message || "Error de transcripción");
    res.json({text:j.text||""});
  }catch(e){ res.status(500).json({error:e.message}); }
  finally{ try{fs.unlinkSync(req.file.path)}catch{} }
});

app.post("/api/render", upload.fields([
  {name:"audio",maxCount:1},{name:"images",maxCount:100}
]), async (req,res)=>{
  const audio=req.files?.audio?.[0];
  const images=req.files?.images||[];
  if(!audio || !images.length) return res.status(400).json({error:"Necesitas audio e imágenes."});
  let work=null;
  try{
    work=fs.mkdtempSync(path.join(os.tmpdir(),"aive4-"));
    const aspect=req.body.aspect||"16:9";
    const durations=JSON.parse(req.body.durations||"[]");
    const size=aspect==="9:16"?"720:1280":aspect==="1:1"?"1080:1080":"1280:720";
    const list=[];
    images.forEach((im,i)=>{
      const ext=path.extname(im.originalname)||".jpg";
      const dst=path.join(work,`img_${String(i).padStart(4,"0")}${ext}`);
      fs.copyFileSync(im.path,dst);
      const d=Math.max(0.2,Number(durations[i]||3));
      list.push({file:dst,d});
    });
    const concat=path.join(work,"concat.txt");
    let txt="";
    for(const x of list){
      txt += `file '${x.file.replace(/'/g,"'\\\\''")}'\n`;
      txt += `duration ${x.d}\n`;
    }
    txt += `file '${list[list.length-1].file.replace(/'/g,"'\\\\''")}'\n`;
    fs.writeFileSync(concat,txt);

    const out=path.join(work,"video.mp4");
    await run("ffmpeg",[
      "-y","-f","concat","-safe","0","-i",concat,
      "-i",audio.path,
      "-vf",`scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`,
      "-c:v","libx264","-preset","veryfast","-crf","23",
      "-c:a","aac","-b:a","128k","-shortest","-movflags","+faststart",out
    ]);
    res.download(out,"video_editado.mp4",()=>{
      try{fs.rmSync(work,{recursive:true,force:true})}catch{}
    });
  }catch(e){
    try{if(work)fs.rmSync(work,{recursive:true,force:true})}catch{}
    res.status(500).json({error:e.message});
  }
});

app.listen(PORT,()=>console.log(`AI Video Editor V4 running on ${PORT}`));
