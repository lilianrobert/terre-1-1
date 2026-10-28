// GLSL for terrain, water, trees, buildings, wind streaks and the atmosphere/cloud composite pass.

export const NWAVES = 16;
export const NWAVES_VERT = 6;
export const CLOUD_H = 2600.0;

const common = /* glsl */`
// atmosphere of the body we are on (Earth, Mars; the Moon has none)
uniform float uPR;
uniform vec3 uBR;
uniform float uBM;
uniform float uHR;
uniform float uHM;
uniform float uAtm;
uniform vec3 uSkyTint;
#define PR uPR
#define BR uBR
#define BM uBM

// sunlight reaching a point whose local up has dot(up, sun) = mu
vec3 sunTrans(float mu) {
  float m = clamp(mu, -1.0, 1.0);
  float z = degrees(acos(m));
  float am = 1.0 / (max(m, 0.0) + 0.50572 * pow(max(96.07995 - z, 1e-3), -1.6364));
  am = min(am, 40.0);
  vec3 tau = BR * uHR + vec3(BM * 1.1 * uHM);
  return exp(-tau * am) * smoothstep(-0.03, 0.02, m);
}
vec3 skyAmbient(float mu) {
  vec3 day = vec3(0.30, 0.42, 0.70) * smoothstep(-0.12, 0.35, mu);
  vec3 dusk = vec3(0.35, 0.18, 0.12) * smoothstep(-0.15, 0.0, mu) * (1.0 - smoothstep(0.0, 0.3, mu));
  return (day + dusk) * uSkyTint * uAtm + vec3(0.006, 0.008, 0.016) * mix(0.25, 1.0, uAtm);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
// value noise, periodic so chunk-local coordinates (wrapped every 2048 m) stay seamless
float pnoise(vec3 p, float per) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  #define HP(o) hash13(mod(i + o, per))
  return mix(mix(mix(HP(vec3(0,0,0)), HP(vec3(1,0,0)), f.x), mix(HP(vec3(0,1,0)), HP(vec3(1,1,0)), f.x), f.y),
             mix(mix(HP(vec3(0,0,1)), HP(vec3(1,0,1)), f.x), mix(HP(vec3(0,1,1)), HP(vec3(1,1,1)), f.x), f.y), f.z);
}
vec3 skyColor(vec3 d, vec3 up, float mu) {
  float e = max(dot(d, up), 0.0);
  vec3 zen = vec3(0.10, 0.24, 0.62) * 1.3;
  vec3 hor = vec3(0.55, 0.68, 0.88) * 1.4;
  vec3 c = mix(hor, zen, pow(e, 0.45)) * smoothstep(-0.15, 0.25, mu);
  c += vec3(0.9, 0.45, 0.2) * pow(1.0 - e, 4.0) * smoothstep(-0.2, 0.0, mu) * (1.0 - smoothstep(0.0, 0.35, mu)) * 1.5;
  return c + vec3(0.002, 0.003, 0.006);
}
// wind-driven ripples: 4 octaves of drifting noise, gradient by finite differences
vec3 rippleNormal(vec3 up, vec3 P, float dist, float t, vec3 wdir, float strength) {
  vec3 e = normalize(cross(abs(up.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), up));
  vec3 n = cross(up, e);
  vec3 g = vec3(0.0);
  float s = 64.0;
  for (int i = 0; i < 5; i++) {
    float fade = 1.0 - smoothstep(s * 40.0, s * 160.0, dist);
    if (fade > 0.0) {
      float per = 2048.0 / s;
      vec3 q = (P + wdir * t * (1.2 + 0.6 * float(i)) + up * t * 0.15 * s) / s;
      float h0 = pnoise(q, per);
      float he = pnoise(q + e * 0.3, per);
      float hn = pnoise(q + n * 0.3, per);
      float amp = 0.5 * strength * fade;
      g += (e * (he - h0) + n * (hn - h0)) / 0.3 * amp;
    }
    s *= 0.25;
  }
  return g;
}
vec3 lambert(vec3 N, vec3 up, vec3 sun, float k) {
  float mu = dot(up, sun);
  return sunTrans(mu) * max(dot(N, sun), 0.0) * k + skyAmbient(mu) * (0.55 + 0.45 * dot(N, up));
}
// shading shared by sea and rivers/lakes; base = water body colour (linear)
vec3 shadeWater(vec3 n, vec3 up, vec3 V, vec3 sun, vec3 base, float dist) {
  float mu = dot(up, sun);
  vec3 sunC = sunTrans(mu);
  vec3 Rf = reflect(-V, n);
  Rf = normalize(Rf + up * max(0.0, -dot(Rf, up)) * 1.01);
  float fres = 0.02 + 0.98 * pow(1.0 - max(dot(n, V), 0.0), 5.0);
  vec3 lightIn = sunC * max(mu, 0.0) * 2.0 + skyAmbient(mu);
  float rs = max(dot(Rf, sun), 0.0);
  float spec = pow(rs, 900.0) * 60.0 + pow(rs, 60.0) * 0.4;
  return mix(base * lightIn, skyColor(Rf, up, mu), fres) + sunC * spec;
}
`;


const shadowCommon = /* glsl */`
uniform sampler2D tShadow;
uniform mat4 uShadowMat;
uniform float uShadowOn;
uniform vec2 uShadowTexel;
// sun shadow map: 3x3 PCF, faded out at the edges of the covered area
float shadowAt(vec3 rel, vec3 N) {
  if (uShadowOn < 0.5) return 1.0;
  vec4 sp = uShadowMat * vec4(rel + N * 0.35, 1.0);
  vec3 q = sp.xyz / sp.w * 0.5 + 0.5;
  if (q.x <= 0.0 || q.y <= 0.0 || q.x >= 1.0 || q.y >= 1.0 || q.z >= 1.0) return 1.0;
  float sum = 0.0;
  for (int i = -1; i <= 1; i++) for (int j = -1; j <= 1; j++)
    sum += step(q.z - 0.00012, texture2D(tShadow, q.xy + vec2(float(i), float(j)) * uShadowTexel).r);
  float edge = smoothstep(0.0, 0.07, q.x) * smoothstep(0.0, 0.07, q.y) * (1.0 - smoothstep(0.93, 1.0, q.x)) * (1.0 - smoothstep(0.93, 1.0, q.y));
  return mix(1.0, sum / 9.0, edge);
}
vec3 lambertS(vec3 N, vec3 up, vec3 sun, float k, float sh) {
  float mu = dot(up, sun);
  return sunTrans(mu) * max(dot(N, sun), 0.0) * k * sh + skyAmbient(mu) * (0.55 + 0.45 * dot(N, up));
}
`;


// ---- tsunamis: up to 4 ring waves running out from impact points at uTsuV m/s
const tsuCommon = /* glsl */`
uniform vec4 uTsu[4];        // xyz centre direction, w start time
uniform float uTsuA[4];      // amplitude in deep water (m), 0 = slot unused
uniform float uTsuV;
// height (m) of all running tsunamis here; grad = slope along the ground
float tsunami(vec3 up, float depth, out vec3 grad) {
  float h = 0.0;
  grad = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    float A = uTsuA[i];
    if (A <= 0.0) continue;
    vec3 c = uTsu[i].xyz;
    float rf = (uTime - uTsu[i].w) * uTsuV;
    if (rf <= 0.0) continue;
    float s = atan(length(cross(up, c)), dot(up, c)) * PR;
    // waves rise and steepen into a wall as the sea gets shallow
    float shoal = clamp(pow(3000.0 / max(depth, 6.0), 0.25), 1.0, 3.5);
    float w = (1200.0 + rf * 0.015) / (shoal * shoal);
    float x = (s - rf) / w;
    if (abs(x) > 6.0) continue;
    float a = A * shoal / sqrt(1.0 + rf / 15000.0);
    float x2 = x + 1.8;
    float e1 = exp(-x * x), e2 = exp(-x2 * x2);
    h += a * (e1 - 0.5 * e2);                                              // crest, then the trough that drains the shore
    float dh = a * (-2.0 * x * e1 + x2 * e2) / w;
    vec3 t = up * dot(up, c) - c;
    float tl = length(t);
    if (tl > 1e-9) grad += t / tl * dh;
  }
  return h;
}
`;

// ------------------------------------------------------------------ terrain
export const terrainVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float ah;
uniform vec3 uCenter;
uniform vec3 uOff;
varying vec3 vN;
varying vec2 vUv;
varying vec3 vUp;
varying vec3 vRel;
varying vec3 vP;
varying float vH;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vRel = wp.xyz;
  vN = normal;
  vUv = uv;
  vUp = uCenter + position;
  vP = position + uOff;
  vH = ah;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

export const terrainFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${common}
uniform vec3 uSun;
uniform sampler2D tTex;
uniform float uTime;
uniform vec3 uWindDir;
uniform float uWindStr;
${shadowCommon}
varying vec3 vN;
varying vec2 vUv;
varying vec3 vUp;
varying vec3 vRel;
varying vec3 vP;
varying float vH;

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  vec3 up = normalize(vUp);
  float dist = length(vRel);
  vec4 tx = texture2D(tTex, vUv);
  vec3 alb = pow(tx.rgb, vec3(2.2)) * 1.15;

  // close up, add grain below the imagery resolution
  float d = 0.0;
  float sc = 8.0;
  for (int i = 0; i < 5; i++) {
    float fade = 1.0 - smoothstep(sc * 40.0, sc * 160.0, dist);
    if (fade > 0.0) d += (pnoise(vP / sc, 2048.0 / sc) - 0.5) * fade * 0.5;
    sc *= 0.5;
  }
  alb *= 1.0 + d * 0.3;

  // the imagery already contains soft shading: use a gentler light so relief stays readable without doubling it
  vec3 L = lambertS(N, up, uSun, 2.9, shadowAt(vRel, N));
  vec3 col = alb * L;

  // molten rock at the bottom of deep craters (alpha 3..121)
  float m = smoothstep(0.3, 0.5, tx.r - 1.6 * tx.g - 2.0 * tx.b);   // the mantle's exact red, nothing in imagery is that saturated
  if (m > 0.0) {
    // lava lake: a dark cooling crust broken by glowing cracks that slowly churn
    float crust = pnoise(vP / 64.0 + vec3(0.0, uTime * 0.02, 0.0), 32.0) * 0.6 + pnoise(vP / 16.0 - vec3(uTime * 0.05), 128.0) * 0.4;
    float crack = 1.0 - smoothstep(0.03, 0.12, abs(crust - 0.5));
    float flick = 0.8 + 0.2 * pnoise(vP / 6.0 + vec3(0.0, uTime * 0.6, 0.0), 341.0);
    vec3 hot = mix(vec3(1.0, 0.25, 0.03), vec3(1.0, 0.75, 0.3), crack);
    col = mix(col, vec3(0.03, 0.015, 0.01), m * 0.85) + hot * m * (1.5 + 9.0 * crack) * flick;
  }
  if (tx.a > 0.75 && vH > 0.0) {   // rivers and lakes above sea level
    vec3 V = -vRel / dist;
    vec3 g = rippleNormal(up, vP, dist, uTime, uWindDir, 0.01 + 0.012 * uWindStr);
    vec3 n = normalize(up - g);
    col = shadeWater(n, up, V, uSun, alb * 0.55 + vec3(0.0, 0.01, 0.015), dist);
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ ocean
export const oceanVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
${common}
attribute float ah;
uniform vec3 uCenter;
uniform vec3 uOff;
uniform float uTime;
uniform float uWaveAmp;
uniform vec4 uWaves[${NWAVES}];
uniform vec2 uWaveW[${NWAVES}];
${tsuCommon}
varying vec3 vRel;
varying vec3 vUp;
varying vec3 vP;
varying vec2 vUv;
varying float vDepth;
varying float vDisp;
void main() {
  vec3 up = normalize(uCenter + position);
  vec3 p = position + uOff;
  vec4 wp0 = modelMatrix * vec4(position, 1.0);
  float dist = length(wp0.xyz);
  float fade = 1.0 - smoothstep(1500.0, 6000.0, dist);
  float hs = 0.0;
  if (fade > 0.0) {
    float group = 0.45 + 1.1 * pnoise(p / 512.0, 4.0);       // wave groups: swell comes in sets
    for (int i = 0; i < ${NWAVES_VERT}; i++) {
      vec4 w = uWaves[i];
      hs += w.w * sin(dot(w.xyz, p) - uWaveW[i].x * uTime + uWaveW[i].y);
    }
    hs *= group;
  }
  hs *= fade * uWaveAmp * smoothstep(0.0, 6.0, -ah);           // waves die in the shallows
  vec3 tg;
  float ht = tsunami(up, max(-ah, 0.0), tg);
  vec4 wp = modelMatrix * vec4(position + up * (hs + ht), 1.0);
  vRel = wp.xyz;
  vUp = up;
  vP = p;
  vUv = uv;
  vDepth = -ah;
  vDisp = hs;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;

export const oceanFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${common}
uniform vec3 uSun;
uniform sampler2D tTex;
uniform float uTime;
uniform float uWaveAmp;
uniform float uWaveMax;
uniform vec3 uWindDir;
uniform float uWindStr;
uniform vec4 uWaves[${NWAVES}];
uniform vec2 uWaveW[${NWAVES}];
${tsuCommon}
varying vec3 vRel;
varying vec3 vUp;
varying vec3 vP;
varying vec2 vUv;
varying float vDepth;
varying float vDisp;

void main() {
  #include <logdepthbuf_fragment>
  vec4 tx = texture2D(tTex, vUv);
  vec3 tgrad;
  float ht = tsunami(normalize(vUp), max(vDepth, 0.0), tgrad);
  float code = tx.a * 255.0;
  if ((tx.a < 0.5 && vDepth + ht < 3.0) || (code > 1.5 && code < 60.0)) discard;   // land (unless flooded), polders, dug craters
  if (vDepth + ht < -12.0 && ht < 0.5) discard;
  vec3 up = normalize(vUp);
  float dist = length(vRel);
  vec3 V = -vRel / dist;

  float group = 0.45 + 1.1 * pnoise(vP / 512.0, 4.0);
  vec3 g = vec3(0.0);
  for (int i = 0; i < ${NWAVES}; i++) {
    vec4 w = uWaves[i];
    float lam = 6.2831853 / length(w.xyz);
    float f = 1.0 - smoothstep(lam * 12.0, lam * 60.0, dist);
    if (f <= 0.0) continue;
    float ph = dot(w.xyz, vP) - uWaveW[i].x * uTime + uWaveW[i].y;
    g += w.xyz * (w.w * cos(ph) * f);
  }
  g *= uWaveAmp * group * smoothstep(0.0, 6.0, vDepth);
  g = g - up * dot(g, up);
  g += rippleNormal(up, vP, dist, uTime, uWindDir, 0.012 + 0.016 * uWindStr);
  // slow, large patches of calmer and rougher water break the tiling at mid distance
  float patchN = pnoise(vP / 256.0 + vec3(uTime * 0.01), 8.0);
  g *= 0.7 + 0.6 * patchN;
  g += tgrad;
  vec3 n = normalize(up - g);

  float depth = max(vDepth, 0.0);
  vec3 sat = pow(tx.rgb, vec3(2.2));
  vec3 deep = mix(vec3(0.003, 0.02, 0.045), sat * 0.7, 0.55);
  vec3 shallow = vec3(0.02, 0.17, 0.19);
  vec3 base = mix(shallow, deep, smoothstep(0.0, 35.0, depth)) * (0.85 + 0.3 * patchN);
  vec3 col = shadeWater(n, up, V, uSun, base, dist);

  float mu = dot(up, uSun);
  vec3 lightIn = sunTrans(mu) * max(mu, 0.0) * 2.0 + skyAmbient(mu);
  float near = 1.0 - smoothstep(400.0, 3000.0, dist);
  float fn = smoothstep(0.35, 0.75, pnoise(vP / 3.0 + vec3(uTime * 0.3), 682.0) * 0.6 + pnoise(vP / 0.75, 2730.0) * 0.4);
  // a thin breaking line at the water's edge, pulsing with the swash
  float swash = sin(uTime * 0.8 + dot(vP, vec3(0.05))) * 0.25;
  float shore = smoothstep(0.0, 0.15, depth) * (1.0 - smoothstep(0.2, 0.7, depth - vDisp * 0.4 + swash)) * smoothstep(0.4, 1.0, uWaveAmp);
  float crest = smoothstep(0.55, 1.0, vDisp / max(uWaveMax * uWaveAmp, 0.01)) * smoothstep(0.6, 1.4, uWaveAmp);
  float foam = clamp(shore * 0.55 + crest * 0.6, 0.0, 1.0) * fn * near;
  col = mix(col, vec3(0.75) * lightIn, foam);
  // tsunami: churned white water on the crest, muddy water once it runs over land
  float tfoam = smoothstep(1.5, 9.0, ht) * (0.55 + 0.45 * fn);
  col = mix(col, vec3(0.42, 0.33, 0.22) * lightIn, (1.0 - smoothstep(-4.0, 0.0, vDepth)) * step(0.5, ht) * 0.8);
  // light glowing through the steep face of the wave
  col += vec3(0.04, 0.32, 0.30) * lightIn * smoothstep(0.03, 0.15, length(tgrad)) * smoothstep(3.0, 20.0, ht);
  col = mix(col, vec3(0.82) * lightIn, tfoam * 0.85);
  foam = max(foam, tfoam);

  float alpha = clamp(0.3 + smoothstep(0.0, 8.0, depth) * 0.7 + foam, 0.0, 1.0);
  alpha = max(alpha, 1.0 - pow(max(dot(n, V), 0.0), 2.0) * 0.6);
  gl_FragColor = vec4(col, alpha);
}`;

// ------------------------------------------------------------------ trees (instanced, two LODs)
export const treeVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float ao;
attribute float wood;
attribute vec4 iPos;    // xyz offset from tile centre, w height
attribute vec4 iCol;    // x yaw phase, yzw colour
uniform vec3 uCenter;
uniform float uTime;
uniform vec3 uWindDir;
uniform float uWindStr;
varying vec3 vN;
varying vec3 vUp;
varying vec3 vCol;
varying vec3 vRel;
varying vec3 vLp;
varying float vAO;
varying float vWood;
void main() {
  vec3 up = normalize(uCenter + iPos.xyz);
  vec3 ax = normalize(cross(abs(up.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0), up));
  vec3 bx = cross(up, ax);
  float ph = iCol.x;
  vec3 ax2 = ax * cos(ph) + bx * sin(ph), bx2 = cross(up, ax2);
  float h = iPos.w;
  float sq = 0.85 + 0.3 * fract(ph * 7.13);
  vec3 lp = position * vec3(h * sq, h, h / sq);
  float hy = clamp(position.y, 0.0, 1.0);
  float gust = sin(uTime * 1.7 + ph * 3.0) * 0.5 + 0.5 + 0.3 * sin(uTime * 4.3 + ph * 11.0);
  vec3 p = iPos.xyz + ax2 * lp.x + up * lp.y + bx2 * lp.z + uWindDir * (hy * hy * gust * uWindStr * 0.03 * h);
  vN = normalize(ax2 * (normal.x / sq) + up * normal.y + bx2 * (normal.z * sq));
  vUp = up;
  vCol = iCol.yzw;
  vLp = position * 26.0 + vec3(ph * 13.0);
  vAO = ao;
  vWood = wood;
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vRel = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
export const treeFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${common}
uniform vec3 uSun;
${shadowCommon}
varying vec3 vN;
varying vec3 vUp;
varying vec3 vCol;
varying vec3 vRel;
varying vec3 vLp;
varying float vAO;
varying float vWood;
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  vec3 up = normalize(vUp);
  float dist = length(vRel);
  // clumps of leaves: two scales of cell noise, faded before they shimmer
  float near = 1.0 - smoothstep(80.0, 260.0, dist);
  float leaf = mix(1.0, 0.7 + 0.6 * hash13(floor(vLp)) * (0.6 + 0.4 * hash13(floor(vLp * 2.7))), near);
  vec3 alb = vWood > 0.5 ? vec3(0.06, 0.045, 0.032) : pow(vCol, vec3(2.2)) * leaf;
  float mu = dot(up, uSun);
  float sh = shadowAt(vRel, N);
  vec3 V = -vRel / dist;
  float wrap = max(dot(N, uSun) * 0.6 + 0.4, 0.0);
  float through = pow(max(dot(-V, uSun), 0.0), 6.0) * 0.8;       // sunlight seen through the leaves
  vec3 sun = sunTrans(mu) * 2.5 * sh;
  vec3 col = alb * (sun * (wrap + through * (1.0 - vWood)) + skyAmbient(mu) * (0.5 + 0.5 * dot(N, up))) * vAO;
  gl_FragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ OSM buildings (merged per map tile)
export const cityVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 acol;
attribute vec4 afac;    // u along the wall (m), height above ground (m), style, building height (m)
uniform vec3 uCenter;
varying vec3 vN;
varying vec3 vUp;
varying vec3 vCol;
varying vec4 vFac;
varying vec3 vRel;
varying float vSeed;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vRel = wp.xyz;
  vN = normal;
  vUp = normalize(uCenter + position);
  vCol = acol;
  vFac = afac;
  vSeed = acol.r * 31.0 + acol.g * 17.0 + acol.b * 7.0 + afac.w * 0.37;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
export const cityFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${common}
uniform vec3 uSun;
${shadowCommon}
varying vec3 vN;
varying vec3 vUp;
varying vec3 vCol;
varying vec4 vFac;
varying vec3 vRel;
varying float vSeed;

// one rectangular opening inside a cell, anti-aliased with the cell's screen footprint
float rect(vec2 f, vec2 lo, vec2 hi, vec2 fw) {
  vec2 a = smoothstep(lo - fw, lo + fw, f) * (1.0 - smoothstep(hi - fw, hi + fw, f));
  return a.x * a.y;
}

void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vN);
  vec3 up = normalize(vUp);
  float dist = length(vRel);
  vec3 V = -vRel / dist;
  float mu = dot(up, uSun);
  float night = 1.0 - smoothstep(-0.12, 0.04, mu);
  float style = vFac.z;
  vec3 alb = pow(vCol, vec3(2.2));
  vec3 extra = vec3(0.0);
  float ao = 1.0;
  vec3 Rf = reflect(-V, N);
  float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);
  vec3 sky = skyColor(Rf, up, mu);

  if (style > 0.5 && style < 1.5) {
    // roof: tile courses on pitched roofs, weathered patches everywhere
    float pitched = step(0.01, vFac.y);
    float course = mix(1.0, 0.86 + 0.14 * smoothstep(0.0, 0.25, fract(vFac.y / 0.32)), pitched * (1.0 - smoothstep(60.0, 200.0, dist)));
    alb *= course * (0.86 + 0.28 * hash13(vec3(floor(vFac.xy / 3.0), vSeed)));
  } else {
    float u = vFac.x, v = vFac.y, top = vFac.w;
    float hs = hash13(vec3(vSeed, 1.0, 7.0));
    // per style: bay width, floor height, window opening inside the cell
    vec2 cellM = style > 3.5 ? vec2(1.6, 3.8) : style > 2.5 ? vec2(3.8, 2.9) : style > 1.5 ? vec2(3.0, 3.05) : vec2(3.3 + hs, 3.15);
    vec2 lo = style > 3.5 ? vec2(0.06, 0.1) : style > 2.5 ? vec2(0.33, 0.3) : style > 1.5 ? vec2(0.3, 0.2) : vec2(0.26, 0.28);
    vec2 hi = style > 3.5 ? vec2(0.94, 0.96) : style > 2.5 ? vec2(0.67, 0.78) : style > 1.5 ? vec2(0.7, 0.86) : vec2(0.74, 0.85);
    vec2 cell = vec2(u, v) / cellM;
    vec2 f = fract(cell);
    vec2 fw = fwidth(cell) * 1.2;
    float vis = clamp(1.6 - max(fw.x, fw.y) * 2.2, 0.0, 1.0);
    float ground = style > 1.5 && style < 2.5 ? 4.4 : 3.4;
    float win = rect(f, lo, hi, fw) * step(ground, v) * vis;

    float attic = 0.0;
    if (style > 1.5 && style < 2.5) {
      // Haussmann: stone cornice, zinc mansard with dormers, iron balconies on the 2nd and 5th floors
      attic = step(top - 3.4, v);
      float cornice = smoothstep(top - 3.9, top - 3.6, v) * (1.0 - attic);
      alb = mix(alb, alb * 1.12, cornice);
      vec2 df = vec2(f.x, (v - (top - 3.4)) / 3.4);
      float dormer = rect(df, vec2(0.32, 0.18), vec2(0.68, 0.62), fw) * attic;
      alb = mix(alb, vec3(0.085, 0.095, 0.11), attic);
      win = max(win * (1.0 - attic), dormer * vis);
      float fl = floor((v - ground) / cellM.y);
      float balcony = (step(0.5, abs(fl - 1.0)) < 0.5 || step(0.5, abs(fl - 4.0)) < 0.5) ? smoothstep(0.0, 0.03, f.y) * (1.0 - smoothstep(0.1, 0.13, f.y)) : 0.0;
      alb = mix(alb, vec3(0.025), balcony * vis * step(ground, v) * (1.0 - attic));
      // shopfronts at street level
      float shop = (1.0 - step(ground, v)) * rect(vec2(f.x, v / ground), vec2(0.12, 0.08), vec2(0.88, 0.85), fw);
      alb = mix(alb, vec3(0.03, 0.035, 0.04), shop * vis);
      extra += vec3(1.0, 0.78, 0.5) * shop * night * 0.25 * step(0.35, hash13(vec3(floor(cell.x), vSeed, 4.0)));
    } else if (style > 2.5 && style < 3.5) {
      // houses: painted shutters either side of each window
      vec3 shutter = hs < 0.25 ? vec3(0.08, 0.2, 0.12) : hs < 0.5 ? vec3(0.1, 0.16, 0.3) : hs < 0.75 ? vec3(0.45, 0.45, 0.42) : vec3(0.3, 0.13, 0.08);
      float sh = (rect(f, vec2(lo.x - 0.13, lo.y), vec2(lo.x - 0.01, hi.y), fw) + rect(f, vec2(hi.x + 0.01, lo.y), vec2(hi.x + 0.13, hi.y), fw)) * step(ground - 2.0, v) * vis;
      alb = mix(alb, shutter, sh);
      win = rect(f, lo, hi, fw) * vis;
    } else if (style > 3.5) {
      // glass tower: the whole facade is window, the frame is the wall colour
      alb *= 0.6;
    }
    alb *= mix(0.62, 1.0, smoothstep(0.0, ground, v));                       // grime at street level
    vec3 glass = vec3(0.03, 0.035, 0.045) + sky * (style > 3.5 ? 0.2 + 0.7 * fres : 0.08 + 0.5 * fres);
    float lit = step(style > 3.5 ? 0.45 : 0.62, hash13(vec3(floor(cell), vSeed)));
    alb = mix(alb, vec3(0.0), win * 0.9);
    extra += win * (glass * (1.0 - night * 0.8) + vec3(1.0, 0.7, 0.4) * lit * night * 0.32);
    ao = mix(0.55, 1.0, smoothstep(0.0, 7.0, v));
  }
  vec3 col = alb * lambertS(N, up, uSun, 2.7, shadowAt(vRel, N)) * ao + extra;
  gl_FragColor = vec4(col, 1.0);
}`;

// ------------------------------------------------------------------ hand-built landmarks
export const markVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec4 aL;
varying vec3 vN;
varying vec3 vCol;
varying vec4 vL;
varying vec3 vRel;
varying vec3 vLocal;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vRel = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vCol = color;
  vL = aL;
  vLocal = position;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`;
export const markFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${common}
uniform vec3 uSun;
uniform vec3 uUp;
uniform float uTime;
uniform float uSparkle;
${shadowCommon}
varying vec3 vN;
varying vec3 vCol;
varying vec4 vL;
varying vec3 vRel;
varying vec3 vLocal;
void main() {
  #include <logdepthbuf_fragment>
  float kind = vL.w;
  vec3 N = normalize(vN);
  vec3 up = normalize(uUp);
  float dist = length(vRel);
  vec3 V = -vRel / dist;
  float mu = dot(up, uSun);
  float night = 1.0 - smoothstep(-0.12, 0.04, mu);
  vec3 alb = vCol;
  vec3 emit = vec3(0.0);
  vec3 Rf = reflect(-V, N);
  float fres = pow(1.0 - max(abs(dot(N, V)), 0.0), 4.0);

  if (kind > 0.5 && kind < 1.5) {
    // puddled-iron lattice: St Andrew's crosses between horizontal girders, cut out per pixel.
    // Beams widen with distance so the tower reads as a dark lace, then as a solid silhouette.
    float width = max(vL.z, 1.0);
    float n = max(1.0, floor(width / 6.0 + 0.5));
    float cell = width / n;
    vec2 q = vec2(vL.x * n, vL.y / cell);
    vec2 f = fract(q);
    float fq = max(fwidth(q.x), fwidth(q.y));
    float t = 0.05 + fq * 0.6;
    float diag = min(abs(f.x - f.y), abs(f.x + f.y - 1.0)) * 0.7;
    float girder = min(f.y, 1.0 - f.y);
    float edge = min(vL.x, 1.0 - vL.x) * n * 0.55;
    // second, finer lattice inside each panel
    vec2 f2 = fract(q * 3.0);
    float fine = min(abs(f2.x - f2.y), abs(f2.x + f2.y - 1.0)) * 0.7;
    // the fine lattice only exists up close; further away it would just fill the panels in
    float fq2 = fq * 3.0;
    bool fineOn = fq2 < 0.3;
    if (min(min(diag, girder), edge) > t && (!fineOn || fine > 0.035 + fq2 * 0.5)) discard;
    // golden floodlights, and the hourly sparkle
    emit = vec3(1.0, 0.52, 0.16) * 0.32 * night;
    float sp = step(0.985, hash13(floor(vLocal * 0.6) + vec3(floor(uTime * 9.0)))) * uSparkle * night;
    emit += vec3(2.2, 2.2, 2.0) * sp;
  } else if (kind > 1.5 && kind < 2.5) {
    // curtain wall: mullions every 1.6 m, slabs every 3.8 m, sky reflection, lit offices at night
    vec2 g = vec2(vL.x * vL.z / 1.6, vL.y / 3.8);
    vec2 f = fract(g);
    vec2 fw = fwidth(g);
    float frame = 1.0 - (smoothstep(0.06 - fw.x, 0.06 + fw.x, f.x) * smoothstep(0.1 - fw.y, 0.1 + fw.y, f.y));
    vec3 refl = skyColor(Rf, up, mu) * (0.25 + 0.6 * fres);
    alb = mix(vec3(0.02, 0.025, 0.03), vCol * 0.5, frame);
    emit = refl * (1.0 - frame) + vec3(1.0, 0.85, 0.6) * step(0.55, hash13(vec3(floor(g), 3.0))) * night * (1.0 - frame);
  } else if (kind > 4.5) {
    // glass pyramid: diamond panes on a steel net
    vec2 g = vec2(vL.x * vL.z / 3.0, vL.y / 1.6);
    vec2 f = fract(vec2(g.x + g.y, g.x - g.y));
    vec2 fw = fwidth(g) * 1.4;
    float net = 1.0 - smoothstep(0.05, 0.05 + fw.x, min(f.x, 1.0 - f.x)) * smoothstep(0.05, 0.05 + fw.y, min(f.y, 1.0 - f.y));
    alb = mix(vec3(0.01), vec3(0.2), net);
    emit = skyColor(Rf, up, mu) * (0.3 + 0.7 * fres) * (1.0 - net) + vec3(1.0, 0.86, 0.6) * night * 0.6 * (1.0 - net);
  } else if (kind > 3.5) {
    emit = vCol * pow(max(dot(Rf, uSun), 0.0), 20.0) * 3.0;            // gilding
  } else if (kind < 0.5) {
    // stone: faint coursing, warm floodlight at night
    alb *= 0.93 + 0.07 * step(0.5, fract(vL.y / 0.6));
    emit = alb * vec3(1.0, 0.8, 0.55) * night * 0.25;
  }
  vec3 col = alb * lambertS(N, up, uSun, 2.7, shadowAt(vRel, N)) + emit;
  gl_FragColor = vec4(col, 1.0);
}`;

// searchlight beams from the top of the Eiffel Tower
export const beamVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying float vT;
void main() {
  vT = position.y;           // 0 at the lamp, 1 at the far end
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
export const beamFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uNight;
varying float vT;
void main() {
  #include <logdepthbuf_fragment>
  float a = pow(1.0 - clamp(vT, 0.0, 1.0), 1.6) * uNight * 0.12;
  gl_FragColor = vec4(vec3(1.0, 0.9, 0.72) * a, a);
}`;

// ------------------------------------------------------------------ wind streaks
export const streakVS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute float aA;
varying float vA;
void main() {
  vA = aA;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`;
export const streakFS = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uOpacity;
uniform vec3 uTint;
varying float vA;
void main() {
  #include <logdepthbuf_fragment>
  gl_FragColor = vec4(uTint, vA * uOpacity);
}`;

// ------------------------------------------------------------------ composite (atmosphere, clouds, tonemap)
export const postVS = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

export const postFS = /* glsl */`
#include <common>
${common}
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uInvProj;
uniform mat4 uCamWorld;
uniform vec3 uCamPos;
uniform float uCamR;
uniform float uCamAlt;
uniform float uFar;
uniform float uTime;
uniform vec3 uSun;
uniform vec3 uCloudOff;
uniform float uCloudCover;
uniform float uExposure;
uniform float uAspect;
uniform float uSpeedFx;
uniform float uShockT;
uniform float uShockAmp;
uniform float uVapor;
uniform float uFlash;
varying vec2 vUv;

uniform float uRA;
uniform float uSunI;
#define RA uRA
#define HR uHR
#define HM uHM
#define SUN_I uSunI
const float CH = ${CLOUD_H.toFixed(1)};

float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash13(i), hash13(i + vec3(1,0,0)), f.x), mix(hash13(i + vec3(0,1,0)), hash13(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(hash13(i + vec3(0,0,1)), hash13(i + vec3(1,0,1)), f.x), mix(hash13(i + vec3(0,1,1)), hash13(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float cloudDens(vec3 dir, float oct) {
  vec3 p = dir * 6371.0 + uCloudOff;               // km
  float cov = clamp(uCloudCover + (vnoise(p / 1400.0) - 0.5) * 0.8, 0.0, 1.0);
  const mat3 rot = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
  float n = 0.0, a = 0.5, tot = 0.0;
  vec3 q = p / 140.0;
  for (int i = 0; i < 8; i++) {
    float w = clamp(oct - float(i), 0.0, 1.0);
    if (w <= 0.0) break;
    n += a * w * vnoise(q);
    tot += a; a *= 0.5; q = rot * q * 2.03;
  }
  n /= tot;
  return smoothstep(1.0 - cov, 1.0 - cov + 0.22, n);
}

bool raySphere(vec3 ro, vec3 rd, float r, out float t0, out float t1) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - r * r;
  float d = b * b - c;
  if (d < 0.0) return false;
  d = sqrt(d);
  t0 = -b - d; t1 = -b + d;
  return true;
}

void atmosphere(vec3 rd, float tEnd, float tCld, out vec3 S, out vec3 T, out vec3 Sc, out vec3 Tc) {
  S = vec3(0.0); T = vec3(1.0); Sc = vec3(0.0); Tc = vec3(1.0);
  if (uAtm < 0.5) return;
  vec3 ro = uCamPos;
  float t0, t1;
  if (!raySphere(ro, rd, RA, t0, t1) || t1 < 0.0) return;
  t0 = max(t0, 0.0);
  t1 = min(t1, tEnd);
  if (t1 <= t0) return;
  float mu = dot(rd, uSun);
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.76;
  float pM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  float odR = 0.0, odM = 0.0;
  vec3 sR = vec3(0.0), sM = vec3(0.0);
  float tPrev = t0;
  bool cDone = tCld > 1e30 || tCld < t0;
  const int NS = 16;
  for (int i = 0; i < NS; i++) {
    float a = (float(i) + 1.0) / float(NS);
    float tn = t0 + (t1 - t0) * a * a;
    float ds = tn - tPrev;
    vec3 p = ro + rd * (tPrev + ds * 0.5);
    float h = max(length(p) - PR, 0.0);
    float dR = exp(-h / HR) * ds, dM = exp(-h / HM) * ds;
    odR += dR; odM += dM;
    float b = dot(p, uSun);
    float cP = h * (2.0 * PR + h);
    if (!(b < 0.0 && b * b - cP > 0.0)) {
      float cA = dot(p, p) - RA * RA;
      float tl = -b + sqrt(max(b * b - cA, 0.0));
      float dl = tl / 4.0;
      float lR = 0.0, lM = 0.0;
      for (int j = 0; j < 4; j++) {
        vec3 q = p + uSun * (dl * (float(j) + 0.5));
        float hq = max(length(q) - PR, 0.0);
        lR += exp(-hq / HR) * dl; lM += exp(-hq / HM) * dl;
      }
      vec3 att = exp(-(BR * (odR + lR) + BM * 1.1 * (odM + lM)));
      sR += att * dR; sM += att * dM;
    }
    if (!cDone && tn >= tCld) {
      cDone = true;
      Sc = SUN_I * (sR * BR * pR + sM * BM * pM);
      Tc = exp(-(BR * odR + BM * 1.1 * odM));
    }
    tPrev = tn;
  }
  S = SUN_I * (sR * BR * pR + sM * BM * pM);
  T = exp(-(BR * odR + BM * 1.1 * odM));
  if (!cDone) { Sc = S; Tc = T; }
}

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

void main() {
  // shock wave: an expanding refractive ring after each bang
  vec2 cdir = vUv - 0.5;
  cdir.x *= uAspect;
  float rr = length(cdir);
  float ring = exp(-pow((rr - uShockT * 0.95) * 16.0, 2.0)) * uShockAmp * (1.0 - smoothstep(0.2, 1.3, uShockT));
  vec2 uv = vUv + (cdir / max(rr, 1e-4)) * vec2(1.0 / uAspect, 1.0) * ring * 0.035;
  vec4 sc = texture2D(tColor, uv);
  if (uSpeedFx > 0.01) {        // radial motion blur on the scene, stronger the faster you go
    vec3 acc = sc.rgb;
    for (int i = 1; i < 7; i++) acc += texture2D(tColor, mix(uv, vec2(0.5), float(i) * 0.011 * uSpeedFx)).rgb;
    sc.rgb = acc / 7.0;
  }
  float dz = texture2D(tDepth, uv).r;
  vec4 v = uInvProj * vec4(uv * 2.0 - 1.0, -1.0, 1.0);   // near plane: far plane w underflows in float32
  vec3 rd = normalize(mat3(uCamWorld) * normalize(v.xyz / v.w));
  vec3 fwd = normalize(-vec3(uCamWorld[2]));
  bool sky = dz >= 0.9999999;
  float dist = sky ? 1e32 : (exp2(dz * log2(uFar + 1.0)) - 1.0) / max(dot(rd, fwd), 1e-4);

  // single cloud layer, intersected analytically (numerically safe near the surface)
  vec3 upc = uCamPos / uCamR;
  float mu = dot(rd, upc);
  float rm = uCamR * mu;
  float D = (CH - uCamAlt) * (2.0 * PR + CH + uCamAlt);
  float disc = rm * rm + D;
  float tc = 1e32;
  if (D > 0.0) tc = -rm + sqrt(disc);
  else if (disc > 0.0 && mu < 0.0) tc = -rm - sqrt(disc);

  float cloudA = 0.0;
  vec3 cloudC = vec3(0.0);
  bool above = uCamAlt > CH;
  if (tc < dist && (tc < 1.6e6 || above)) {
    vec3 cd = normalize(uCamPos + rd * tc);
    float oct = clamp(9.5 - log2(max(tc, 1.0) / 3000.0), 3.0, 8.0);
    float dens = cloudDens(cd, oct);
    if (dens > 0.001) {
      float mus = dot(cd, uSun);
      float sh = cloudDens(normalize(cd + uSun * 0.0006), 3.0);
      vec3 sunc = sunTrans(mus) * 2.6;
      float below = step(uCamAlt, CH);
      float thick = mix(1.0, 0.4, dens * below);
      cloudC = (sunc * (0.35 + 0.65 * (1.0 - sh * 0.85)) * thick + skyAmbient(mus) * 1.1) * 0.95;
      cloudC += sunc * pow(max(dot(rd, uSun), 0.0), 10.0) * 0.8 * (1.0 - dens);
      cloudA = dens * smoothstep(0.0, 0.035, abs(dot(rd, cd))) * (above ? 1.0 : 1.0 - smoothstep(7e5, 1.5e6, tc));
    }
  }

  vec3 S, T, Sc, Tc;
  atmosphere(rd, dist, tc < dist ? tc : 1e33, S, T, Sc, Tc);

  vec3 col;
  if (sky) {
    float sd = dot(rd, uSun);
    vec3 sun = vec3(1.0, 0.97, 0.92) * smoothstep(0.99995, 0.99998, sd) * 60.0;
    // stars, Milky Way and other light drawn behind the sky: washed out by a bright sky
    float starVis = 1.0 - smoothstep(0.004, 0.09, dot(S, vec3(0.3, 0.5, 0.2)));
    // alpha in the scene target = smoke/explosion coverage over open sky; additive light (stars) leaves it at 0
    float cover = clamp(sc.a, 0.0, 1.0);
    col = (S + sun * T * uAtm) * (1.0 - cover) + sc.rgb * T * mix(starVis, 1.0, cover) + S * cover * 0.35;
  } else {
    vec3 base = sc.rgb;
    if (dist < 4e5) {   // cloud shadows on the ground
      vec3 P = uCamPos + rd * dist;
      vec3 up = normalize(P);
      float mus = dot(up, uSun);
      float hP = length(P) - PR;
      if (mus > 0.0 && hP < CH) {
        float sd = cloudDens(normalize(P + uSun * ((CH - hP) / max(mus, 0.25))), 3.0);
        base *= 1.0 - 0.6 * sd * smoothstep(0.0, 0.1, mus) * (1.0 - smoothstep(2e5, 4e5, dist));
      }
    }
    col = base * T + S;
  }
  col = mix(col, cloudC * Tc + Sc, cloudA);

  // flying through the cloud layer
  float inC = 1.0 - smoothstep(0.0, 260.0, abs(uCamAlt - CH));
  if (inC > 0.0) {
    float fd = cloudDens(upc, 5.0) * inC;
    float mus = dot(upc, uSun);
    vec3 fogC = sunTrans(mus) * 1.6 + skyAmbient(mus);
    col = mix(col, fogC, fd * 0.93);
  }

  // vapour cone around the transonic barrier, flash of the shock ring, tunnel vignette
  float cone = smoothstep(0.18, 0.42, rr) * (1.0 - smoothstep(0.42, 0.75, rr));
  float swirl = vnoise(vec3(cdir * 9.0 / max(rr, 0.05), uTime * 5.0)) * 0.6 + 0.4;
  vec3 haze = sunTrans(dot(upc, uSun)) * 2.0 + skyAmbient(dot(upc, uSun));
  col = mix(col, haze, clamp(uVapor * cone * swirl * 0.55, 0.0, 0.7));
  col += haze * ring * 0.35;
  col *= 1.0 - uSpeedFx * 0.4 * smoothstep(0.35, 0.85, rr);
  col += vec3(1.0, 0.93, 0.82) * uFlash;   // nuclear flash
  col = aces(col * uExposure);
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash13(vec3(gl_FragCoord.xy, uTime)) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;
