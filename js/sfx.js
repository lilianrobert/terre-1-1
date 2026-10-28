// Synthesised weapon sounds (no audio files): launch thump + whoosh, a rocket roar that follows the
// missile, and a layered blast: crack, body, sub-bass drop and rolling thunder, through a reverb.
export function createSfx(ac, out) {
  const sr = ac.sampleRate;
  const noise = (sec, brown) => {
    const b = ac.createBuffer(2, sr * sec, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let last = 0;
      for (let i = 0; i < d.length; i++) {
        const w = Math.random() * 2 - 1;
        if (brown) { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; } else d[i] = w;
      }
    }
    return b;
  };
  const white = noise(3, false), brown = noise(6, true);
  // big-space reverb: decaying stereo noise impulse
  const verb = ac.createConvolver();
  {
    const len = sr * 4.5, ir = ac.createBuffer(2, len, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    verb.buffer = ir;
  }
  const wet = ac.createGain();
  wet.gain.value = 0.55;
  verb.connect(wet).connect(out);

  const src = (buf, rate = 1, loop = false) => {
    const s = ac.createBufferSource();
    s.buffer = buf; s.loop = loop; s.playbackRate.value = rate;
    return s;
  };
  const env = (g, t, peak, attack, decay) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };
  const route = (node, send = 0.4) => {
    node.connect(out);
    const s = ac.createGain(); s.gain.value = send;
    node.connect(s).connect(verb);
  };

  function launch() {
    const t = ac.currentTime;
    // thump of the motor lighting
    const o = ac.createOscillator(), og = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    env(og, t, 0.9, 0.005, 0.45);
    o.connect(og); route(og, 0.25);
    o.start(t); o.stop(t + 0.6);
    // tearing whoosh, rising then fading as it leaves
    const n = src(white, 1), f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = 'bandpass'; f.Q.value = 1.4;
    f.frequency.setValueAtTime(350, t);
    f.frequency.exponentialRampToValueAtTime(2600, t + 0.5);
    f.frequency.exponentialRampToValueAtTime(900, t + 1.6);
    env(g, t, 0.8, 0.04, 1.5);
    n.connect(f).connect(g); route(g, 0.5);
    n.start(t, Math.random()); n.stop(t + 1.8);
  }

  // continuous roar while a missile flies; gain is driven from its distance
  function rocket() {
    const n = src(brown, 1.8, true), f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = 'lowpass'; f.frequency.value = 1400;
    g.gain.value = 0.0001;
    n.connect(f).connect(g); route(g, 0.3);
    n.start(ac.currentTime, Math.random() * 3);
    return {
      set(level, bright) { const t = ac.currentTime; g.gain.setTargetAtTime(Math.max(0.0001, level), t, 0.05); f.frequency.setTargetAtTime(300 + 2400 * bright, t, 0.1); },
      stop() { const t = ac.currentTime; g.gain.setTargetAtTime(0.0001, t, 0.03); n.stop(t + 0.3); },
    };
  }

  // deep rumble of a rock tearing through the atmosphere
  function roar() {
    const n = src(brown, 0.7, true), f = ac.createBiquadFilter(), g = ac.createGain();
    f.type = 'lowpass'; f.frequency.value = 300;
    g.gain.value = 0.0001;
    n.connect(f).connect(g); route(g, 0.6);
    n.start(ac.currentTime, Math.random() * 3);
    return {
      set(level, heat) { const t = ac.currentTime; g.gain.setTargetAtTime(Math.max(0.0001, level), t, 0.1); f.frequency.setTargetAtTime(150 + 1100 * heat, t, 0.2); },
      stop() { const t = ac.currentTime; g.gain.setTargetAtTime(0.0001, t, 0.05); n.stop(t + 0.5); },
    };
  }

  // vol 0..1 (distance already applied), near 0..1 (1 = right next to it: keeps the high crack)
  function blast(vol, near) {
    const t = ac.currentTime;
    // 1. the crack: a very short, bright transient
    if (near > 0.05) {
      const n = src(white, 1), f = ac.createBiquadFilter(), g = ac.createGain();
      f.type = 'highpass'; f.frequency.value = 1200;
      env(g, t, 1.4 * vol * near, 0.002, 0.12);
      n.connect(f).connect(g); route(g, 0.6);
      n.start(t, Math.random()); n.stop(t + 0.2);
    }
    // 2. the body: wide noise whose brightness collapses as the pressure wave passes
    {
      const n = src(brown, 1), f = ac.createBiquadFilter(), g = ac.createGain();
      f.type = 'lowpass'; f.Q.value = 0.8;
      f.frequency.setValueAtTime(400 + 2600 * near, t);
      f.frequency.exponentialRampToValueAtTime(110, t + 2.5);
      env(g, t, 2.2 * vol, 0.01, 4.5);
      n.connect(f).connect(g); route(g, 0.7);
      n.start(t, Math.random() * 2); n.stop(t + 5);
    }
    // 3. sub-bass drop you feel more than hear
    {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(62, t);
      o.frequency.exponentialRampToValueAtTime(24, t + 3);
      env(g, t, 1.6 * vol, 0.02, 3.4);
      o.connect(g); route(g, 0.2);
      o.start(t); o.stop(t + 3.6);
    }
    // 4. rolling thunder: low rumble that swells and fades in waves for many seconds
    {
      const n = src(brown, 0.6, true), f = ac.createBiquadFilter(), g = ac.createGain(), lfo = ac.createOscillator(), lg = ac.createGain();
      f.type = 'lowpass'; f.frequency.value = 160;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(1.3 * vol, t + 0.8);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 11);
      lfo.frequency.value = 0.7; lg.gain.value = 0.5 * vol;
      lfo.connect(lg).connect(g.gain);
      n.connect(f).connect(g); route(g, 0.8);
      n.start(t, Math.random() * 4); n.stop(t + 11.5); lfo.start(t); lfo.stop(t + 11.5);
    }
  }

  return { launch, rocket, roar, blast };
}
