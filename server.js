import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs/promises';
import { existsSync, createReadStream } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = path.join('/tmp', 'gta-clips', 'uploads');
const outputDir = path.join('/tmp', 'gta-clips', 'outputs');
const workDir = path.join('/tmp', 'gta-clips', 'work');

await Promise.all([
  fs.mkdir(uploadDir, { recursive: true }),
  fs.mkdir(outputDir, { recursive: true }),
  fs.mkdir(workDir, { recursive: true })
]);

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 500 * 1024 * 1024 }
});
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(express.static(path.join(__dirname, 'public')));
app.use('/outputs', express.static(outputDir));
app.use(express.json());

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.on('data', d => error += d.toString());
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error(error || `${command} terminou com código ${code}`)));
  });
}
function safeName(name) { return name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 50) || 'video'; }
async function durationOf(file) {
  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file]);
    let stdout=''; let stderr=''; child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
    child.on('error',reject); child.on('close',c=>c===0?resolve({stdout}):reject(new Error(stderr)));
  });
  return Number(stdout.trim());
}
function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2,'0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2,'0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2,'0');
  const milli = String(ms % 1000).padStart(3,'0');
  return `${h}:${m}:${s},${milli}`;
}
async function transcribeInParts(video, dir, duration) {
  const audio = path.join(dir, 'audio.mp3');
  await run('ffmpeg', ['-y','-i',video,'-vn','-ac','1','-ar','16000','-b:a','48k',audio]);
  const audioDuration = await durationOf(audio);
  const partSeconds = 480;
  const allSegments = [];
  for (let start = 0, part = 0; start < audioDuration; start += partSeconds, part++) {
    const piece = path.join(dir, `audio-${part}.mp3`);
    await run('ffmpeg', ['-y','-ss',String(start),'-t',String(partSeconds),'-i',audio,'-c','copy',piece]);
    const stat = await fs.stat(piece);
    if (stat.size < 1000) continue;
    const result = await openai.audio.transcriptions.create({
      file: createReadStream(piece), model: 'whisper-1', response_format: 'verbose_json', timestamp_granularities: ['segment'], language: 'pt'
    });
    for (const seg of (result.segments || [])) {
      allSegments.push({ start: Number(seg.start) + start, end: Number(seg.end) + start, text: seg.text.trim() });
    }
    await fs.unlink(piece).catch(()=>{});
  }
  await fs.unlink(audio).catch(()=>{});
  if (!allSegments.length) throw new Error('Não consegui identificar falas. Tente um vídeo com áudio mais claro.');
  return allSegments;
}
async function chooseMoments(segments, duration) {
  const compact = segments.map((s,i)=>({i,start:Number(s.start.toFixed(1)),end:Number(s.end.toFixed(1)),text:s.text}));
  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini', temperature: 0.3,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: 'Você é editor de vídeos curtos de gameplay. Selecione cinco momentos com maior potencial de prender a atenção: humor, surpresa, reação, reviravolta, fala marcante ou situação curiosa. Não invente acontecimentos. Escolha momentos sustentados pelo texto. Retorne JSON com a chave clips, uma lista de exatamente 5 objetos com start, end, title e reason. Cada clipe deve ter entre 20 e 45 segundos, estar dentro da duração do vídeo e evitar sobreposição. Se o material não tiver cinco momentos fortes, escolha os melhores trechos disponíveis mesmo assim.' },
      { role: 'user', content: `Duração do vídeo: ${duration.toFixed(1)} segundos. Transcrição com tempos: ${JSON.stringify(compact)}` }
    ]
  });
  const raw = response.choices[0]?.message?.content || '{}';
  const parsed = JSON.parse(raw);
  const clips = Array.isArray(parsed.clips) ? parsed.clips : [];
  const normalized = clips.slice(0,5).map((c,i)=>{
    let start = Math.max(0, Math.min(duration-1, Number(c.start)||0));
    let end = Math.max(start+5, Math.min(duration, Number(c.end)||start+30));
    if (end-start > 45) end = start+45;
    if (end-start < 20) { start = Math.max(0,end-20); }
    return { start, end, title: String(c.title||`Momento ${i+1}`).slice(0,70), reason: String(c.reason||'Trecho selecionado pela IA').slice(0,140) };
  });
  if (!normalized.length) throw new Error('A IA não encontrou trechos para montar os cortes.');
  return normalized;
}
async function renderClip(video, clip, segments, out, index) {
  const clipSegments = segments.filter(s => s.end >= clip.start && s.start <= clip.end);
  const srt = clipSegments.map((s,i)=>{
    const start = Math.max(0, s.start-clip.start);
    const end = Math.max(start+0.25, Math.min(clip.end-clip.start, s.end-clip.start));
    return `${i+1}\n${srtTime(start)} --> ${srtTime(end)}\n${s.text.replace(/[<>]/g,'')}`;
  }).join('\n\n');
  const srtPath = path.join(path.dirname(out), `captions-${index}.srt`);
  await fs.writeFile(srtPath, srt || '1\n00:00:00,000 --> 00:00:02,000\nGTA CLIPS AI');
  const escaped = srtPath.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");
  const vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,subtitles='${escaped}':force_style='FontName=Arial,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=120'`;
  await run('ffmpeg', ['-y','-ss',String(clip.start),'-i',video,'-t',String(clip.end-clip.start),'-vf',vf,'-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart',out]);
  await fs.unlink(srtPath).catch(()=>{});
}

app.post('/api/process', upload.single('video'), async (req,res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({error:'Configure OPENAI_API_KEY no arquivo .env antes de iniciar.'});
  if (!req.file) return res.status(400).json({error:'Envie um arquivo de vídeo.'});
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const dir = path.join(workDir, jobId);
  try {
    await fs.mkdir(dir, {recursive:true});
    const ext = path.extname(req.file.originalname).toLowerCase() || '.mp4';
    const video = path.join(dir, `source${ext}`);
    await fs.rename(req.file.path, video);
    const duration = await durationOf(video);
    if (!Number.isFinite(duration) || duration < 25) throw new Error('O vídeo precisa ter pelo menos 25 segundos.');
    const segments = await transcribeInParts(video, dir, duration);
    const clips = await chooseMoments(segments, duration);
    const results = [];
    for (let i=0; i<clips.length; i++) {
      const filename = `${safeName(path.parse(req.file.originalname).name)}-corte-${i+1}.mp4`;
      const out = path.join(outputDir, `${jobId}-${filename}`);
      await renderClip(video, clips[i], segments, out, i+1);
      results.push({ title: clips[i].title, reason: clips[i].reason, start: clips[i].start, end: clips[i].end, url: `/outputs/${path.basename(out)}` });
    }
    res.json({ success:true, clips:results });
  } catch (err) {
    res.status(500).json({error: err.message || 'Falha ao processar o vídeo.'});
  } finally {
    await fs.rm(dir, {recursive:true,force:true}).catch(()=>{});
    if (req.file?.path) await fs.unlink(req.file.path).catch(()=>{});
  }
});

app.get('/api/health', (_req,res)=>res.json({ok:true}));
app.listen(PORT, ()=>console.log(`GTA Clips AI rodando em http://localhost:${PORT}`));
