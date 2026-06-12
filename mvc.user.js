// ==UserScript==
// @name         Moises Visual Metronome
// @namespace    dansec.red
// @version      1.1
// @match        https://studio.moises.ai/*
// @match        https://studio1.moises.ai/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
'use strict';

// ── IFRAME SIDE (studio1.moises.ai) ────────────────────────
if (location.hostname === 'studio1.moises.ai') {
  const OrigAC = window.AudioContext || window.webkitAudioContext;
  let busy = false, prevUrl = null;

  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(dest, ...rest) {
    if (dest instanceof AudioDestinationNode && this instanceof AudioWorkletNode) {
      this.port.addEventListener('message', ev => {
        if (!ev.data?.status) return;
        const s = ev.data.status;

        window.parent.postMessage({
          type:'mvc-tick', posMs:s.positionMs||0,
          on:!!s.isPlaying, rate:s.playbackRate||1
        }, 'https://studio.moises.ai');

        if (!busy && s.readyToPlay && s.channels) {
          const m = s.channels.find(c => c.id==='metronome');
          if (m?.url && m.url !== prevUrl) {
            prevUrl = m.url; busy = true;
            doAnalysis(m.url, OrigAC).finally(() => { busy = false; });
          }
        }
      });
    }
    return origConnect.call(this, dest, ...rest);
  };

  async function doAnalysis(url, AC) {
    post('status', 'analysing…');
    try {
      const bytes = await (await fetch(url)).arrayBuffer();
      const ctx   = new AC();
      const abuf  = await ctx.decodeAudioData(bytes);
      ctx.close();
      const raw   = pickPeaks(abuf);
      const clean = dedupe(raw);
      const bpm   = medBpm(clean);
      post('beats', { beats:clean, bpm });
    } catch(e) { post('status', 'analysis failed'); }
  }

  function pickPeaks(abuf) {
    const ch  = abuf.getChannelData(0);
    const sr  = abuf.sampleRate;
    const hop = Math.round(sr / 1000);   // 1ms per hop
    const n   = Math.floor(ch.length / hop);
    const GAP = 150;                      // 150ms min between beats

    const amp = new Float32Array(n);
    let mx = 0;
    for (let i=0; i<n; i++) {
      let p=0;
      for (let j=i*hop, e=Math.min(j+hop,ch.length); j<e; j++) {
        const v = ch[j]<0 ? -ch[j] : ch[j];
        if (v>p) p=v;
      }
      amp[i]=p; if(p>mx) mx=p;
    }

    const thr=mx*0.30, fall=mx*0.04;
    const out=[]; let lastI=-GAP, below=true;

    for (let i=0; i<n; i++) {
      if (below && amp[i]>=thr && i-lastI>=GAP) {
        // Find true peak within next 15ms
        let pi=i, pv=amp[i];
        for (let k=i+1; k<Math.min(i+15,n); k++) {
          if (amp[k]>pv) { pv=amp[k]; pi=k; }
          else if (amp[k]<pv*0.4) break;
        }
        out.push(pi*hop/sr*1000);  // ms, actual audio timestamp
        lastI=pi; below=false;
      } else if (!below && amp[i]<fall) { below=true; }
    }
    return out;
  }

  function dedupe(raw) {
    if (raw.length<3) return raw;
    const iois = raw.slice(1).map((t,i)=>t-raw[i]).sort((a,b)=>a-b);
    const min  = iois[iois.length>>1] * 0.55;
    const out  = [raw[0]];
    for (let i=1; i<raw.length; i++)
      if (raw[i]-out[out.length-1] >= min) out.push(raw[i]);
    return out;
  }

  function medBpm(beats) {
    if (beats.length<2) return null;
    const iois = beats.slice(1).map((t,i)=>t-beats[i]).sort((a,b)=>a-b);
    return Math.round(60000 / iois[iois.length>>1]);
  }

  const post = (t,d) => window.parent.postMessage(
    t==='status' ? {type:'mvc-status',msg:d} : {type:'mvc-beats',...d},
    'https://studio.moises.ai'
  );
  return;
}

// ── PARENT SIDE (studio.moises.ai) ─────────────────────────
if (location.hostname !== 'studio.moises.ai') return;

let beats=null, detBpm=null, manBpm=120, manMode=false;
let bpb=4, shift=0, taps=[], fsMode=false;
let lastBI=-1, beatTimer=null;
// Playback state (updated on each tick)
let posMs=0, wallMs=0, rate=1, playing=false;

// Bluetooth latency compensation
let btOffset = 0, lastFlashWall = 0, calActive = false, calTaps = [];
const CAL_NEEDED = 5;

const S = document.createElement('style');
S.textContent = `
  #mvc-bar {
    position:fixed;bottom:0;left:0;right:0;height:52px;
    pointer-events:none;z-index:2147483647;opacity:0;will-change:opacity;
  }
  #mvc-bar.c1 {
    background:linear-gradient(to top,
      rgba(0,255,200,.97) 0%,rgba(0,210,255,.82) 45%,transparent 100%);
    filter:drop-shadow(0 -10px 30px rgba(0,255,200,.65));
  }
  #mvc-bar.cx {
    background:linear-gradient(to top,
      rgba(255,60,172,.92) 0%,rgba(160,60,200,.68) 45%,transparent 100%);
    filter:drop-shadow(0 -8px 22px rgba(255,60,172,.52));
  }
  #mvc-fs {
    position:fixed;inset:0;pointer-events:none;
    z-index:2147483644;opacity:0;will-change:opacity;display:none;
  }
  #mvc-fs.active { display:block; }
  #mvc-fs.c1 { background:rgba(0,255,200,.52); }
  #mvc-fs.cx { background:rgba(180,50,200,.44); }
  @keyframes mvc-out { from{opacity:1} to{opacity:0} }
  #mvc-bar.go, #mvc-fs.go { animation:mvc-out 520ms ease-out forwards; }

  #mvc-w {
    position:fixed;bottom:28px;right:28px;
    background:rgba(3,3,11,.96);border:1px solid rgba(0,255,200,.18);
    border-radius:12px;padding:13px 16px;z-index:2147483646;
    font-family:'JetBrains Mono',monospace;font-size:11px;color:#00ffc8;
    cursor:move;user-select:none;min-width:186px;
    box-shadow:0 8px 40px rgba(0,0,0,.65);
  }
  #mvc-w button {
    background:rgba(0,255,200,.06);border:1px solid rgba(0,255,200,.18);
    color:#00ffc8;cursor:pointer;border-radius:5px;
    font-family:inherit;transition:background .1s;
  }
  #mvc-w button:hover  { background:rgba(0,255,200,.18); }
  #mvc-w button:active { background:rgba(0,255,200,.28); }
  #mvc-w button.lit    { background:rgba(0,255,200,.22);border-color:rgba(0,255,200,.45); }
  .mr { display:flex;align-items:center;gap:7px;margin-bottom:9px; }
  .lb { opacity:.3;font-size:9px;letter-spacing:1.1px;text-transform:uppercase; }
  #mvc-bpm { font-size:28px;font-weight:700;min-width:52px;text-align:center;color:#00ffe0; }
  #mvc-bpm.m { color:#ff3cac; }
  #mvc-dots { display:flex;gap:5px;margin-bottom:9px;flex-wrap:wrap; }
  .md {
    width:9px;height:9px;border-radius:50%;
    background:rgba(0,255,200,.07);border:1px solid rgba(0,255,200,.15);
    transition:background .05s,box-shadow .05s;
  }
  .md.d1 { background:#00ffe0;box-shadow:0 0 10px rgba(0,255,210,.8); }
  .md.dx { background:#ff3cac;box-shadow:0 0 7px rgba(255,60,172,.65); }
  #mvc-led {
    width:7px;height:7px;border-radius:50%;background:#111;
    transition:background .15s,box-shadow .15s;flex-shrink:0;
  }
  #mvc-led.on { background:#00ffc8;box-shadow:0 0 6px rgba(0,255,200,.6); }
  #mvc-sub { opacity:.25;font-size:9px;margin-top:4px; }

  /* ── Bluetooth panel ── */
  #mvc-bt-panel {
    display:none;
    border-top:1px solid rgba(0,255,200,.1);
    margin-top:10px;padding-top:10px;
  }
  #mvc-bt-panel.open { display:block; }
  #mvc-bt-badge { font-size:9px;opacity:.55;margin-left:3px; }
  #mvc-bt-badge.on { opacity:1;color:#00ffe0; }
  #mvc-bt-ms { font-size:16px;font-weight:700;min-width:58px;text-align:center;color:#00ffe0; }
  #mvc-bt-hint { text-align:center;opacity:.28;font-size:9px;margin-top:3px; }
  @keyframes mvc-cal-pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
  #mvc-bt-cal.cal-active {
    background:rgba(255,60,172,.18);border-color:rgba(255,60,172,.5);
    color:#ff3cac;animation:mvc-cal-pulse 700ms ease-in-out infinite;
  }
`;
document.head.appendChild(S);

const barEl = document.createElement('div'); barEl.id='mvc-bar';
const fsEl  = document.createElement('div'); fsEl.id='mvc-fs';
const wEl   = document.createElement('div'); wEl.id='mvc-w';
wEl.innerHTML = `
  <div class="mr" style="margin-bottom:11px">
    <div id="mvc-led"></div>
    <span class="lb">Visual Metronome</span>
    <span id="mvc-inf" style="margin-left:auto;opacity:.28;font-size:9px">waiting…</span>
  </div>
  <div class="mr">
    <button id="mvc-dn" style="width:26px;height:26px;font-size:19px;line-height:1">−</button>
    <span id="mvc-bpm">-</span>
    <button id="mvc-up" style="width:26px;height:26px;font-size:19px;line-height:1">+</button>
    <span class="lb">bpm</span>
  </div>
  <div id="mvc-dots"></div>
  <div class="mr">
    <span class="lb">bar</span>
    <button id="mvc-bd" style="width:20px;height:20px">−</button>
    <span id="mvc-bpb" style="min-width:14px;text-align:center">4</span>
    <button id="mvc-bu" style="width:20px;height:20px">+</button>
    <button id="mvc-sh" style="height:22px;padding:0 7px;font-size:9px;margin-left:4px">SHIFT</button>
    <button id="mvc-tp" style="flex:1;height:22px;font-size:9px;margin-left:2px">TAP</button>
  </div>
  <div class="mr" style="margin-bottom:5px">
    <button id="mvc-fsb" style="flex:1;height:28px;font-size:9px;letter-spacing:.8px">FULLSCREEN</button>
  </div>
  <!-- Bluetooth toggle -->
  <div class="mr" style="margin-bottom:0">
    <button id="mvc-bt-toggle" style="flex:1;height:28px;font-size:9px;letter-spacing:.8px;display:flex;align-items:center;justify-content:center;gap:5px">
      <svg width="9" height="13" viewBox="0 0 9 13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="4.5" y1="0.5" x2="4.5" y2="12.5"/><polyline points="4.5,0.5 8,3.5 4.5,6.5"/><polyline points="4.5,6.5 8,9.5 4.5,12.5"/></svg>
      BT OFFSET <span id="mvc-bt-badge">+0ms</span>
    </button>
  </div>
  <!-- Bluetooth panel (collapsed by default) -->
  <div id="mvc-bt-panel">
    <div class="mr" style="margin-bottom:8px">
      <span class="lb" style="opacity:.4">Bluetooth Latency</span>
    </div>
    <div class="mr">
      <button id="mvc-bt-dn" style="width:24px;height:24px;font-size:16px">−</button>
      <span id="mvc-bt-ms">+0 ms</span>
      <button id="mvc-bt-up" style="width:24px;height:24px;font-size:16px">+</button>
      <button id="mvc-bt-rst" style="height:24px;padding:0 9px;font-size:9px;margin-left:2px">RST</button>
    </div>
    <div class="mr" style="margin-bottom:3px">
      <button id="mvc-bt-cal" style="flex:1;height:30px;font-size:9px;letter-spacing:.8px">TAP TO CALIBRATE</button>
    </div>
    <div id="mvc-bt-hint">tap when you hear each beat</div>
  </div>
  <div id="mvc-sub">load a track to sync</div>
`;

function init() {
  document.body.appendChild(barEl);
  document.body.appendChild(fsEl);
  document.body.appendChild(wEl);

  const bpmEl = document.getElementById('mvc-bpm');
  const infEl = document.getElementById('mvc-inf');
  const subEl = document.getElementById('mvc-sub');
  const bpbEl = document.getElementById('mvc-bpb');
  const dtsEl = document.getElementById('mvc-dots');
  const ledEl = document.getElementById('mvc-led');
  const fsBt  = document.getElementById('mvc-fsb');

  const showBpm = () => {
    bpmEl.textContent = manMode ? manBpm : (detBpm ?? '-');
    bpmEl.classList.toggle('m', manMode);
  };

  const buildDots = () => {
    dtsEl.innerHTML = '';
    for (let i=0; i<bpb; i++) {
      const d=document.createElement('div'); d.className='md';
      dtsEl.appendChild(d);
    }
  };
  buildDots();

  document.getElementById('mvc-dn').onclick = () => {
    if (!manMode) manBpm = detBpm ?? manBpm;
    manMode=true; manBpm=Math.max(20,manBpm-1);
    subEl.textContent='manual bpm'; showBpm(); restart();
  };
  document.getElementById('mvc-up').onclick = () => {
    if (!manMode) manBpm = detBpm ?? manBpm;
    manMode=true; manBpm=Math.min(320,manBpm+1);
    subEl.textContent='manual bpm'; showBpm(); restart();
  };
  document.getElementById('mvc-bd').onclick = () => {
    bpb=Math.max(1,bpb-1); bpbEl.textContent=bpb; buildDots(); restart();
  };
  document.getElementById('mvc-bu').onclick = () => {
    bpb=Math.min(16,bpb+1); bpbEl.textContent=bpb; buildDots(); restart();
  };
  document.getElementById('mvc-sh').onclick  = () => { shift=(shift+1)%bpb; restart(); };
  document.getElementById('mvc-tp').onclick  = () => {
    const now=Date.now();
    taps=taps.filter(t=>now-t<3500); taps.push(now);
    if (taps.length>=2) {
      const avg=taps.slice(1).map((t,i)=>t-taps[i]).reduce((a,b)=>a+b)/(taps.length-1);
      manBpm=Math.max(20,Math.min(320,Math.round(60000/avg)));
      manMode=true; subEl.textContent='tap bpm'; showBpm(); restart();
    }
  };
  fsBt.onclick = () => {
    fsMode=!fsMode;
    fsEl.classList.toggle('active',fsMode);
    fsBt.classList.toggle('lit',fsMode);
    fsBt.textContent = fsMode ? 'FULLSCREEN ✦' : 'FULLSCREEN';
  };

  // Bluetooth
  const btPanel  = document.getElementById('mvc-bt-panel');
  const btBadge  = document.getElementById('mvc-bt-badge');
  const btMsEl   = document.getElementById('mvc-bt-ms');
  const btHint   = document.getElementById('mvc-bt-hint');
  const btCalBt  = document.getElementById('mvc-bt-cal');
  const btToggle = document.getElementById('mvc-bt-toggle');

  const showBt = () => {
    const sign = btOffset >= 0 ? '+' : '';
    btMsEl.textContent  = `${sign}${btOffset} ms`;
    btBadge.textContent = `${sign}${btOffset}ms`;
    btBadge.classList.toggle('on', btOffset !== 0);
  };

  btToggle.onclick = () => {
    btPanel.classList.toggle('open');
    btToggle.classList.toggle('lit', btPanel.classList.contains('open'));
  };
  document.getElementById('mvc-bt-dn').onclick = () => {
    btOffset = Math.max(-500, btOffset - 5); showBt(); restart();
  };
  document.getElementById('mvc-bt-up').onclick = () => {
    btOffset = Math.min(1000, btOffset + 5); showBt(); restart();
  };
  document.getElementById('mvc-bt-rst').onclick = () => {
    btOffset=0; calActive=false; calTaps=[];
    btCalBt.classList.remove('cal-active');
    btCalBt.textContent='TAP TO CALIBRATE';
    btHint.textContent='tap when you hear each beat';
    showBt(); restart();
  };
  btCalBt.onclick = () => {
    if (!calActive) {
      calActive=true; calTaps=[];
      btCalBt.classList.add('cal-active');
      btCalBt.textContent='LISTENING… TAP NOW';
      btHint.textContent=`tap 0 / ${CAL_NEEDED}`;
    } else {
      if (lastFlashWall <= 0) return;
      const delta = performance.now() - lastFlashWall;
      if (delta >= 20 && delta <= 800) {
        calTaps.push(delta);
        btHint.textContent=`tap ${calTaps.length} / ${CAL_NEEDED}`;
      }
      if (calTaps.length >= CAL_NEEDED) {
        const sorted  = [...calTaps].sort((a,b)=>a-b);
        const trimmed = sorted.slice(1,-1);
        const avg     = Math.round(trimmed.reduce((a,b)=>a+b) / trimmed.length);
        btOffset = Math.max(-500, Math.min(1000, btOffset + avg));
        calActive=false; calTaps=[];
        btCalBt.classList.remove('cal-active');
        btCalBt.textContent='TAP TO CALIBRATE';
        const sign = btOffset>=0?'+':'';
        btHint.textContent=`set to ${sign}${btOffset}ms`;
        showBt(); restart();
      }
    }
  };

  // Drag
  let drag=false, ox=0, oy=0;
  wEl.addEventListener('mousedown', e => {
    if (e.target.tagName==='BUTTON') return;
    drag=true; const r=wEl.getBoundingClientRect();
    ox=e.clientX-r.left; oy=e.clientY-r.top;
  });
  document.addEventListener('mousemove', e => {
    if (!drag) return;
    wEl.style.left=(e.clientX-ox)+'px'; wEl.style.top=(e.clientY-oy)+'px';
    wEl.style.right='auto'; wEl.style.bottom='auto';
  });
  document.addEventListener('mouseup', ()=>{ drag=false; });

  // Flash
  const dotT={};
  function doFlash(b1) {
    lastFlashWall = performance.now();   // record for BT calibration
    const cls = b1?'c1':'cx';
    barEl.classList.remove('c1','cx','go'); void barEl.offsetWidth;
    barEl.classList.add(cls,'go');
    if (fsMode) {
      fsEl.classList.remove('c1','cx','go'); void fsEl.offsetWidth;
      fsEl.classList.add(cls,'go');
    }
  }
  function dotOn(idx, b1) {
    dtsEl.querySelectorAll('.md').forEach(d=>d.classList.remove('d1','dx'));
    const d=dtsEl.children[idx%bpb];
    if (!d) return;
    d.classList.add(b1?'d1':'dx');
    clearTimeout(dotT[idx]);
    dotT[idx]=setTimeout(()=>d.classList.remove('d1','dx'),480);
  }

  // ── Predictive scheduler ──────────────────────────────────
  // Eliminates polling jitter by computing exact wall-clock delay
  // to next beat and firing with setTimeout.

  function estPos() {
    return posMs + (performance.now() - wallMs) * rate;
  }

  function scheduleNext() {
    clearTimeout(beatTimer);
    if (!playing) return;
    if (!beats && !manMode) return;

    const np = estPos();

    if (!manMode && beats?.length) {
      const idx = lastBI + 1;
      if (idx >= beats.length) return;
      const delay = Math.max(0, (beats[idx] - np) / rate) + btOffset;
      beatTimer = setTimeout(() => {
        if (!playing) return;
        const b1 = (idx + shift) % bpb === 0;
        doFlash(b1); dotOn(idx, b1); lastBI = idx;
        scheduleNext();
      }, delay);
    } else {
      // Manual / fallback BPM mode
      const bpm  = detBpm && !manMode ? detBpm : manBpm;
      const bInt = 60000 / bpm;
      const next = (Math.floor(np / bInt) + 1) * bInt;
      const nb   = Math.round(next / bInt);
      const delay = Math.max(0, (next - np) / rate) + btOffset;
      beatTimer = setTimeout(() => {
        if (!playing) return;
        const b1 = (nb + shift) % bpb === 0;
        doFlash(b1); dotOn(nb % bpb, b1); lastBI = nb;
        scheduleNext();
      }, delay);
    }
  }

  function restart() {
    clearTimeout(beatTimer);
    const np = estPos();
    if (beats?.length) {
      let lo=-1;
      for (let i=beats.length-1; i>=0; i--) {
        if (beats[i]<=np) { lo=i; break; }
      }
      lastBI = lo;
    } else {
      const bpm  = detBpm && !manMode ? detBpm : manBpm;
      lastBI = Math.floor(np / (60000/bpm)) - 1;
    }
    if (playing) scheduleNext();
  }

  window.addEventListener('message', e => {
    if (e.origin !== 'https://studio1.moises.ai') return;
    const d = e.data; if (!d) return;

    if (d.type==='mvc-status') { infEl.textContent=d.msg; return; }

    if (d.type==='mvc-beats') {
      beats=d.beats; detBpm=d.bpm; manMode=false;
      if (detBpm) manBpm=detBpm;
      showBpm();
      infEl.textContent=`${beats.length} beats`;
      subEl.textContent=detBpm?`${detBpm} bpm · +/− to override`:'beats loaded';
      restart();
      return;
    }

    if (d.type !== 'mvc-tick') return;

    const wasPlaying = playing;
    const oldEst     = estPos();      // estimated pos BEFORE updating state

    posMs=d.posMs; wallMs=performance.now(); rate=d.rate||1;
    playing=d.on;
    ledEl.classList.toggle('on', playing);

    if (!playing) { clearTimeout(beatTimer); return; }

    const seeked = wasPlaying && Math.abs(d.posMs - oldEst) > 500;

    if (!wasPlaying || seeked) {
      restart();                      // start fresh or recover from seek
    }
    // else: let the running setTimeout fire naturally -- no jitter
  });
}

if (document.readyState==='loading') document.addEventListener('DOMContentLoaded', init);
else init();

})();