'use strict';
// tiny env loader
const fs = require('fs');
if (fs.existsSync('.env')) for (const l of fs.readFileSync('.env','utf8').split(/\r?\n/)){const t=l.trim();if(!t||t.startsWith('#'))continue;const e=t.indexOf('=');if(e<0)continue;const k=t.slice(0,e).trim();let v=t.slice(e+1).trim();if((v[0]==='"'&&v.endsWith('"')))v=v.slice(1,-1);if(process.env[k]===undefined)process.env[k]=v;}
const path=require('path');
const vns=require('./lib/veononstop');
const poyo=require('./lib/poyo-image-gpt2');
const run=process.argv[2];
const sceneNum=Number(process.argv[3]||2);
const pack=JSON.parse(fs.readFileSync(path.join(run,'pack.json'),'utf8'));
const img=(pack.images||[]).find(i=>i.scene_number===sceneNum);
const vp=(pack.videoPrompts||[]).find(v=>v.scene_number===sceneNum);

(async()=>{
  const POYO=process.env.POYO_API_KEY, BASE=process.env.POYO_BASE||'https://api.poyo.ai', VNS=process.env.VEONONSTOP_API_KEY;
  console.log('uploading scene',sceneNum,'image…');
  const url=await poyo.uploadFile(POYO,BASE,img.file);
  console.log('img url:',url);
  console.log('submitting…');
  let item=await vns.submitVideoJob(VNS, vp.prompt, url);
  console.log('submitted task:',item.taskId,'status:',item.status);
  for(let r=0;r<8;r++){
    await vns.sleep(8000);
    [item]=await vns.checkVideoStatuses(VNS,[item]);
    console.log('round',r,'status=',item.status,'error=',item.error||'(none)','videoUrl=',item.videoUrl||'(none)');
    if(item.status==='succeeded'||['failed','error','failed_after_retries'].includes(String(item.status).toLowerCase())) break;
  }
  console.log('FINAL:',JSON.stringify({status:item.status,error:item.error,videoUrl:item.videoUrl}));
})().catch(e=>{console.error('PROBE ERR:',e.message);process.exit(1);});
