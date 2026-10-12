// WebGL2 resources: the two programs, the instanced tube mesh, the spine
// texture and the grow-only G-buffer. Ported from the owner-approved prototype (not in this repo).
// Never throws to the host: init() and ensureFbo() report failure by return
// value so the engine can switch to the fallback still.

import { K, MAXR, NR, NS } from "./cubConfig";
import { FS_C, FS_G, VS_C, VS_G } from "./cubShaders";

const G_UNIFORMS = ["uSpine", "uVP", "uTube", "uTube2", "uAnc", "uZ0", "uZk", "uDark", "uEye"] as const;
const C_UNIFORMS = [
  "uA",
  "uB",
  "uInfo",
  "uAnch",
  "uDpr",
  "uLW",
  "uLWi",
  "uSeed",
  "uZinv",
  "uOrg",
  "uSz",
  "uOff",
  "uMainR",
  "uDbg",
  "uInk",
  "uPaper",
  "uSurf",
  "uEyeA",
  "uEyeB",
  "uEyeC",
  "uDark",
  "uEdge",
  "uCrown",
  "uFace",
  "uMouth",
  "uMouthB",
  "uShd",
  "uShdT",
] as const;
type GUni = Record<(typeof G_UNIFORMS)[number], WebGLUniformLocation | null>;
type CUni = Record<(typeof C_UNIFORMS)[number], WebGLUniformLocation | null>;

export type DepthFormat = "f32" | "f16" | "u8";

export class CubGl {
  readonly gl: WebGL2RenderingContext;
  PG: WebGLProgram | null = null;
  PC: WebGLProgram | null = null;
  vao: WebGLVertexArrayObject | null = null;
  vbuf: WebGLBuffer | null = null;
  ibuf: WebGLBuffer | null = null;
  nIdx = 0;
  spineTex: WebGLTexture | null = null;
  fbo: WebGLFramebuffer | null = null;
  tA: WebGLTexture | null = null;
  tB: WebGLTexture | null = null;
  rbD: WebGLRenderbuffer | null = null;
  fbW = 0;
  fbH = 0;
  depthFmt: DepthFormat = "f32";
  ug = {} as GUni;
  uc = {} as CUni;
  private shaders: WebGLShader[] = [];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  private sh(type: number, src: string): WebGLShader | null {
    const gl = this.gl;
    const s = gl.createShader(type);
    if (!s) return null;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    this.shaders.push(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) return null;
    return s;
  }

  private prog(vs: string, fs: string): WebGLProgram | null {
    const gl = this.gl;
    const v = this.sh(gl.VERTEX_SHADER, vs);
    const f = this.sh(gl.FRAGMENT_SHADER, fs);
    const p = gl.createProgram();
    if (!v || !f || !p) return null;
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return null;
    return p;
  }

  /** Compiles everything. False when the GPU refuses (the engine then shows the fallback). */
  init(forceU8 = false): boolean {
    const gl = this.gl;
    this.depthFmt = forceU8
      ? "u8"
      : gl.getExtension("EXT_color_buffer_float")
        ? "f32"
        : gl.getExtension("EXT_color_buffer_half_float")
          ? "f16"
          : "u8";
    this.PG = this.prog(VS_G, FS_G);
    this.PC = this.prog(VS_C, FS_C);
    if (!this.PG || !this.PC) return false;
    for (const n of G_UNIFORMS) this.ug[n] = gl.getUniformLocation(this.PG, n);
    for (const n of C_UNIFORMS) this.uc[n] = gl.getUniformLocation(this.PC, n);
    const v: number[] = [];
    const id: number[] = [];
    for (let i = 0; i <= NS; i++) for (let j = 0; j <= NR; j++) v.push(i / NS, j / NR);
    for (let i = 0; i < NS; i++)
      for (let j = 0; j < NR; j++) {
        const a = i * (NR + 1) + j;
        const b = a + NR + 1;
        id.push(a, b, a + 1, a + 1, b, b + 1);
      }
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    this.vbuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(v), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.ibuf = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(id), gl.STATIC_DRAW);
    this.nIdx = id.length;
    gl.bindVertexArray(null);
    this.spineTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.spineTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, K * 3, MAXR, 0, gl.RGBA, gl.FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return true;
  }

  private dropFbo(): void {
    const gl = this.gl;
    if (this.tA) gl.deleteTexture(this.tA);
    if (this.tB) gl.deleteTexture(this.tB);
    if (this.rbD) gl.deleteRenderbuffer(this.rbD);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.tA = this.tB = null;
    this.rbD = null;
    this.fbo = null;
  }

  /** Grows the G-buffer (128-px steps, never shrinks). False if even the 8-bit layout is incomplete. */
  ensureFbo(w: number, h: number): boolean {
    const gl = this.gl;
    w = Math.ceil(w / 128) * 128;
    h = Math.ceil(h / 128) * 128;
    if (w <= this.fbW && h <= this.fbH) return true;
    this.fbW = Math.max(w, this.fbW);
    this.fbH = Math.max(h, this.fbH);
    w = this.fbW;
    h = this.fbH;
    this.dropFbo();
    const mk = (ifmt: number, fmt: number, type: number) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, ifmt, w, h, 0, fmt, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tA = mk(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.tB = this.depthFmt !== "u8" ? mk(gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT) : mk(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.rbD = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.rbD);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tA, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.tB, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.rbD);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const st = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (st !== gl.FRAMEBUFFER_COMPLETE) {
      if (this.depthFmt !== "u8") {
        this.depthFmt = "u8";
        this.fbW = this.fbH = 0;
        return this.ensureFbo(w, h);
      }
      return false;
    }
    return true;
  }

  /** Frees every GL object (the context itself is released by the engine). */
  dispose(): void {
    const gl = this.gl;
    if (gl.isContextLost()) return;
    this.dropFbo();
    if (this.spineTex) gl.deleteTexture(this.spineTex);
    if (this.vbuf) gl.deleteBuffer(this.vbuf);
    if (this.ibuf) gl.deleteBuffer(this.ibuf);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.PG) gl.deleteProgram(this.PG);
    if (this.PC) gl.deleteProgram(this.PC);
    for (const s of this.shaders) gl.deleteShader(s);
    this.shaders = [];
    this.spineTex = this.vbuf = this.ibuf = null;
    this.vao = null;
    this.PG = this.PC = null;
  }
}
