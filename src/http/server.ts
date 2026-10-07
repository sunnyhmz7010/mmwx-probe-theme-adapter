import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import WebSocket, { WebSocketServer } from 'ws'

import type { AppConfig } from '../config.js'
import { HTTP_PORT } from '../config.js'
import { KomariDataService } from '../komari/service.js'
import type { LoadedTheme } from '../theme/types.js'
import type { ApiRouter } from './api.js'
import { dispatchRpc2, getAdminSessionMe } from './api.js'
import { serveFavicon, serveStatic } from './static.js'
import type { ProbeStreamRelay } from '../mmwx/stream-relay.js'
import { ADAPTER_VERSION } from '../version.js'
import { noopLogger, type Logger } from '../log.js'
import type { MonitorDataService } from '../monitor/service.js'

export interface ServerHandle {
  listen(): Promise<void>
  close(): Promise<void>
}

export function createHttpServer(config: AppConfig, theme: LoadedTheme, api: ApiRouter, hub: ProbeStreamRelay, logger: Logger = noopLogger, listenPort: number = HTTP_PORT, monitor?: MonitorDataService): ServerHandle {
  const snapshotService = new KomariDataService(hub)
  const clientsWss = new WebSocketServer({ noServer: true })
  const streamWss = new WebSocketServer({ noServer: true })
  const clients = new Set<WebSocket>()
  const server = http.createServer(async (request, response) => {
    const startedAt = Date.now()
    const path = new URL(request.url ?? '/', 'http://adapter.local').pathname
    response.once('finish', () => {
      logger.info('HTTP 请求', {
        method: request.method ?? 'GET',
        path,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
      })
    })
    if (serveHealthcheck(request, response)) return
    if (await api.handle(request, response)) return
    if (serveThemeManifest(theme, request, response)) return
    if (serveAdmin(theme, request, response)) return
    if (await serveFavicon(snapshotService, request, response)) return
    if (await serveStatic(theme.directory, request, response)) return
    return jsonNotFound(response)
  })

  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://adapter.local')
    logger.info('WebSocket 请求', { method: request.method ?? 'GET', path: url.pathname })
    if (url.pathname === '/api/ws' && monitor) {
      streamWss.handleUpgrade(request, socket, head, (downstream) => {
        hub.subscribe(downstream, (payload) => monitor.snapshot(payload))
        downstream.on('close', () => hub.unsubscribe(downstream))
        downstream.on('error', () => hub.unsubscribe(downstream))
      })
      return
    }
    if (url.pathname === '/api/rpc2') {
      clientsWss.handleUpgrade(request, socket, head, (ws) => {
        clients.add(ws)
        ws.on('close', () => clients.delete(ws))
        ws.on('message', async (raw) => {
          try {
            const rpc = JSON.parse(raw.toString()) as { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, string | number | boolean | undefined> }
            ws.send(JSON.stringify(await dispatchRpc2(snapshotService, rpc, getAdminSessionMe(request, config.adminToken))))
          } catch {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }))
          }
        })
      })
      return
    }
    if (url.pathname === '/api/clients') {
      clientsWss.handleUpgrade(request, socket, head, (ws) => {
        clients.add(ws)
        ws.on('close', () => clients.delete(ws))
        ws.on('message', async (raw) => {
          if (raw.toString().trim() !== 'get') return
          const snapshot = await snapshotService.getSnapshot()
          ws.send(JSON.stringify({
            online: snapshot.nodes.some((node) => node.online),
            data: snapshot.nodes,
          }))
        })
      })
      return
    }
    if (url.pathname === '/api/stream') {
      streamWss.handleUpgrade(request, socket, head, (downstream) => {
        hub.subscribe(downstream)
        downstream.on('close', () => hub.unsubscribe(downstream))
        downstream.on('error', () => hub.unsubscribe(downstream))
      })
      return
    }
    socket.destroy()
  })

  return {
    listen: async () => {
      // 测试使用临时端口时只监听回环；生产 8080 保持容器对外监听行为。
      await new Promise<void>((resolve) => server.listen(listenPort, listenPort === HTTP_PORT ? undefined : '127.0.0.1', resolve))
    },
    close: async () => {
      for (const ws of clients) ws.close()
      hub.close()
      await new Promise<void>((resolve) => clientsWss.close(() => resolve()))
      await new Promise<void>((resolve) => streamWss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function serveHealthcheck(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const url = new URL(request.url ?? '/', 'http://adapter.local')
  if (url.pathname !== '/ping') return false
  response.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })
  response.end(request.method === 'HEAD' ? undefined : 'pong')
  return true
}

function serveThemeManifest(theme: LoadedTheme, request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const url = new URL(request.url ?? '/', 'http://adapter.local')
  const filename = theme.kind === 'monitor' ? 'theme.json' : 'komari-theme.json'
  if (theme.kind === 'monitor') {
    if (url.pathname !== `/themes/${encodeURIComponent(theme.short ?? '')}/${filename}`) return false
  } else if (!/^\/themes\/[^/]+\/komari-theme\.json$/.test(url.pathname)) return false
  if (!theme.manifest) return false
  response.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })
  response.end(request.method === 'HEAD' ? undefined : JSON.stringify(theme.manifest))
  return true
}

function jsonNotFound(response: ServerResponse): boolean {
  response.writeHead(404, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify({ status: 'error', message: 'not found', data: null }))
  return true
}

function serveAdmin(theme: LoadedTheme, request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false
  const url = new URL(request.url ?? '/', 'http://adapter.local')
  if (url.pathname !== '/admin' && !url.pathname.startsWith('/admin/')) return false
  if (url.pathname === '/admin/dashboard' || url.pathname === '/admin/dashboard/') {
    response.writeHead(302, {
      Location: '/admin',
      'Cache-Control': 'no-store',
    })
    response.end()
    return true
  }
  // 仅 /admin 及其尾斜杠形式展示设置页，其余 /admin/* 一律拒绝访问。
  if (url.pathname !== '/admin' && url.pathname !== '/admin/') {
    return jsonNotFound(response)
  }
  const html = adminThemeSettingsHtml(theme)
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  })
  response.end(request.method === 'HEAD' ? undefined : html)
  return true
}

function htmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', '\\u003c')
}

function supportsFrontendThemeManagement(theme: LoadedTheme): boolean {
  const repository = theme.source.repoUrl
    .replace(/^https:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .toLowerCase()
  if ([
    'stqfdyr/komari-theme-lumina',
    'shanyang242/komari-theme-luminaplus',
    'vaspike/junimo',
  ].includes(repository)) {
    return true
  }
  try {
    return /(?:view=theme-manage|theme-manage)/i.test(readFileSync(theme.indexPath, 'utf8'))
  } catch {
    return false
  }
}

export function adminThemeSettingsHtml(theme: LoadedTheme): string {
  const title = htmlEscape(theme.title ?? theme.short ?? 'Komari Theme')
  const repoUrl = theme.source.repoUrl
  const repoDisplay = repoUrl.replace(/^https:\/\/github\.com\//, '').replace(/\/+$/, '')
  const frontendThemeManagement = supportsFrontendThemeManagement(theme)
  const meta = {
    kind: theme.kind ?? 'komari',
    title: theme.title,
    short: theme.short,
    repoUrl: theme.source.repoUrl,
    ref: theme.source.ref,
    frontendThemeManagement,
  }
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MMWX Probe Theme Adapter Settings</title>
<style>
:root{--bg:#eef2f7;--card:#fff;--ink:#0f172a;--muted:#64748b;--brand:#2563eb;--brand-2:#1d4ed8;--border:#e2e8f0;--accent:#6366f1}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:linear-gradient(180deg,#eef2f7,#e6ebf3);color:var(--ink);min-height:100vh}
.wrap{max-width:720px;margin:0 auto;padding:40px 20px 64px}
header{margin-bottom:24px}
h1{font-size:24px;font-weight:700;margin:0 0 6px;letter-spacing:-.3px}
.meta{display:flex;flex-wrap:wrap;gap:16px;margin-top:14px;font-size:13px;color:var(--muted)}
.meta b{color:#334155;font-weight:600}
.meta a{color:var(--brand);text-decoration:none;font-weight:500}
.meta a:hover{text-decoration:underline}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;box-shadow:0 1px 3px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.04);overflow:hidden}
.card+.card{margin-top:20px}
.card-head{padding:14px 22px;border-bottom:1px solid var(--border);font-size:15px;font-weight:600;display:flex;align-items:center;gap:8px}
.card-head .dot{width:8px;height:8px;border-radius:50%;background:var(--accent)}
.fields{padding:4px 22px 14px}
.field{padding:10px 0;border-bottom:1px solid #f1f5f9}
.field:last-child{border-bottom:0}
label{display:block;font-weight:600;font-size:14px;margin-bottom:7px}
.hint{font-size:12.5px;color:var(--muted);margin-top:5px;line-height:1.5}
h3{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:#94a3b8;margin:12px 0 4px}
input[type=text],input[type=number],input[type=password],select,textarea{width:100%;padding:9px 12px;border:1px solid var(--border);border-radius:10px;font:inherit;font-size:14px;background:#fbfcfe;color:var(--ink);transition:border-color .15s,box-shadow .15s}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px rgba(37,99,235,.15);background:#fff}
textarea{min-height:110px;resize:vertical}
.switch{position:relative;display:inline-block;width:46px;height:26px;flex:none}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;cursor:pointer;inset:0;background:#cbd5e1;border-radius:999px;transition:.2s}
.slider:before{content:"";position:absolute;height:20px;width:20px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s;box-shadow:0 1px 3px rgba(0,0,0,.2)}
.switch input:checked+.slider{background:var(--brand)}
.switch input:checked+.slider:before{transform:translateX(20px)}
.switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px}
.switch-row label{margin:0}
.actions{padding:16px 22px 20px;text-align:center}
.actions .field{padding:0;border:0;text-align:left;margin-bottom:14px}
.actions .btn+.btn{margin-left:10px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:11px 28px;border:0;border-radius:10px;background:var(--brand);color:#fff;font-weight:600;font-size:14px;cursor:pointer;transition:background .15s,transform .05s}
.btn:hover{background:var(--brand-2)}
.btn:active{transform:translateY(1px)}
.btn:disabled{background:#9ca3af;cursor:not-allowed}
.msg{margin:10px 0 0;font-size:13.5px;font-weight:600}
.msg.ok{color:#059669}.msg.error{color:#dc2626}
.empty{text-align:center;padding:72px 24px;color:#475569}
.empty h2{font-size:20px;margin:0;color:#1e293b}
.empty p{margin:8px 0 0;color:var(--muted);font-size:14px}
</style>
</head>
<body>
<div class="wrap">
<header>
<h1>MMWX Probe Theme Adapter Settings</h1>
<div class="meta">
<span>版本：<b>${htmlEscape(ADAPTER_VERSION)}</b></span>
<span>当前主题：<b>${title}</b></span>
<span>仓库：<a href="${htmlEscape(repoUrl)}" target="_blank" rel="noreferrer">${htmlEscape(repoDisplay)}</a> @ ${htmlEscape(theme.source.ref)}</span>
</div>
</header>
<div id="app">加载中...</div>
</div>
<script id="theme-meta" type="application/json">${safeJson(meta)}</script>
<script>
const app=document.getElementById("app");
const meta=JSON.parse(document.getElementById("theme-meta").textContent);
const html=(v)=>String(v).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;","\\"":"&quot;","'":"&#39;"}[c]));
const label=(v)=>typeof v==="string"?v:v&&typeof v==="object"?(v["zh-CN"]||v.zh||v.en||Object.values(v)[0]||""):"";
const parseOptions=(v)=>Array.isArray(v)?v:String(v||"").split(",").map((x)=>x.trim()).filter(Boolean);
let verified=false;
async function json(url,init){
 const r=await fetch(url,init);
 const text=await r.text();
 let d=null;
 if(text){try{d=JSON.parse(text)}catch{if(!r.ok)throw new Error("HTTP "+r.status);throw new Error("服务器返回了无效 JSON")}}
 if(!r.ok)throw new Error((d&&d.message)||("HTTP "+r.status));
 return d&&((d.data??d.result)??d);
}
function fieldValue(settings,f){return settings&&Object.prototype.hasOwnProperty.call(settings,f.key)?settings[f.key]:f.default}
function renderField(f,settings){
  if(f.type==="title")return '<h3>'+html(label(f.label??f.name)||"设置")+'</h3>';
 if(f.type==="textbox")return '<p class="hint">'+html(label(f.name)||label(f.help)||"")+'</p>';
 if(!f.key)return "";
  const name=html(label(f.label??f.name)||f.key), help=label(f.help);
 const value=fieldValue(settings,f);
 let control="";
 if(f.type==="switch"||f.type==="boolean"){control='<div class="switch-row"><label>'+name+'</label><label class="switch"><input data-key="'+html(f.key)+'" data-type="switch" type="checkbox" '+(value===true?"checked":"")+'><span class="slider"></span></label></div>'}
 else if(f.type==="select"||f.type==="radio"){control='<label>'+name+'</label><select data-key="'+html(f.key)+'" data-type="value">'+parseOptions(f.options).map((o)=>{const ov=typeof o==="object"?(o.value??o.key??o.label??o.name):o;return '<option value="'+html(ov)+'" '+(String(value)===String(ov)?"selected":"")+'>'+html(typeof o==="object"?label(o.label??o.name)||ov:o)+'</option>'}).join("")+'</select>'}
  else if(f.type==="number"||f.type==="integer"||f.type==="slider"){control='<label>'+name+'</label><input data-key="'+html(f.key)+'" data-type="number" type="number" step="any" '+(f.min!==undefined?'min="'+html(f.min)+'" ':'')+(f.max!==undefined?'max="'+html(f.max)+'" ':'')+'value="'+html(value??0)+'">'}
  else if(meta.kind==="monitor"&&f.type==="text"){control='<label>'+name+'</label><textarea data-key="'+html(f.key)+'" data-type="value">'+html(value??"")+'</textarea>'}
 else if(f.type==="richtext"||f.type==="nodes"||f.type==="pingtasks"){control='<label>'+name+'</label><textarea data-key="'+html(f.key)+'" data-type="'+(f.type==="richtext"?"value":"json")+'">'+html(f.type==="richtext"?(value??""):JSON.stringify(value??[]))+'</textarea>'}
 else{control='<label>'+name+'</label><input type="text" data-key="'+html(f.key)+'" data-type="value" value="'+html(value??"")+'">'}
 return '<div class="field">'+control+(help?'<p class="hint">'+html(help)+'</p>':"")+'</div>';
}
function collect(){
 const out={};
 for(const el of app.querySelectorAll("[data-key]")){
  const key=el.getAttribute("data-key"), type=el.getAttribute("data-type");
  if(type==="switch")out[key]=el.checked;
   else if(type==="number"){if(!el.value.trim()||!el.checkValidity())throw new Error(key+" 的数值不在允许范围内");out[key]=Number(el.value)}
  else if(type==="json"){try{out[key]=JSON.parse(el.value||"[]")}catch{throw new Error(key+" 不是有效 JSON")}}
  else out[key]=el.value;
 }
 return out;
}
async function boot(){
 try{
 const pub=await json("/api/public");
  const theme=meta.kind==="monitor"?meta.short:(pub.theme||meta.short||"current");
  const manifest=await json("/themes/"+encodeURIComponent(theme)+(meta.kind==="monitor"?"/theme.json":"/komari-theme.json")).catch(()=>null);
  const cfg=manifest&&(meta.kind==="monitor"?{type:"managed",data:manifest.config}:manifest.configuration);
 const settings=await json("/api/admin/theme/settings").catch(()=>pub.theme_settings||{});
  const me=await json("/api/me").catch(()=>null);
   verified=Boolean(me&&(me.logged_in||me.authed));
  if(!cfg){
   app.innerHTML=authCard()+'<div class="card"><div class="empty"><h2>当前主题未声明可配置项</h2>'+(meta.frontendThemeManagement?'<p>当前主题提供前端配置页面，请先完成管理员验证，再访问 <a href="/?view=theme-manage">/?view=theme-manage</a> 进行设置。</p>':"")+'</div></div>';
   attachAuth();
   return
  }
  const type=String(cfg.type||"managed").toLowerCase();
  if(type==="redirect"){app.innerHTML=authCard()+'<div class="card"><div class="empty"><h2>主题配置使用跳转页面</h2><p><a href="'+html(cfg.data||"#")+'">'+html(cfg.data||"打开")+'</a></p></div></div>';attachAuth();return}
  if(type==="raw"){app.innerHTML=authCard()+'<div class="card"><iframe sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" style="width:100%;height:70vh;border:0;display:block" srcdoc="'+html(cfg.data||"")+'"></iframe></div>';attachAuth();return}
  const fields=Array.isArray(cfg.data)?cfg.data:[];
  app.innerHTML=authCard()+'<div class="card"><div class="card-head"><span class="dot"></span>主题配置</div><div class="fields">'+fields.map((f)=>renderField(f,settings)).join("")+'</div><div class="actions"><button class="btn" id="save" disabled>保存主题配置</button><p class="msg" id="save-msg"></p></div></div>';
  attachAuth();
  attachSave();
 }catch(e){app.innerHTML='<div class="card"><div class="empty"><h2>加载失败</h2><p class="msg error">'+html(e.message||e)+'</p></div></div>'}
}
 function authCard(){return '<div class="card"><div class="card-head"><span class="dot"></span>管理员验证</div><div class="actions"><div class="field"><label>ADMIN_TOKEN</label><input id="admin-token" type="password" autocomplete="current-password"></div><button class="btn" id="verify">验证</button><button class="btn" id="logout" disabled>退出登录</button><p class="msg" id="auth-msg"></p></div></div>'}
 function flash(element,className,text){if(!element)return;clearTimeout(element._timer);element.className="msg "+className;element.textContent=text;element._timer=setTimeout(()=>{element.textContent="";element.className="msg"},3000)}
 function updateAuthState(){
  const verify=document.getElementById("verify"), logout=document.getElementById("logout"), save=document.getElementById("save");
  if(verify)verify.disabled=verified;
  if(logout)logout.disabled=!verified;
  if(save)save.disabled=!verified;
 }
 function attachAuth(){
  const button=document.getElementById("verify"), logout=document.getElementById("logout");
  if(!button||!logout){return}
  updateAuthState();
  button.onclick=async()=>{
   const msg=document.getElementById("auth-msg");
   try{
    const token=document.getElementById("admin-token").value.trim();
    if(!token)throw new Error("请输入 ADMIN_TOKEN");
    await json("/api/admin/auth/verify",{method:"POST",headers:{"Authorization":"Bearer "+token}});
    verified=true;
    updateAuthState();
    flash(msg,"ok","验证成功，登录态已建立");
   }catch(e){verified=false;updateAuthState();flash(msg,"error",e.message||e)}
  };
  logout.onclick=async()=>{
   const msg=document.getElementById("auth-msg");
   try{
    await json("/api/admin/auth/logout",{method:"POST"});
    verified=false;
    const token=document.getElementById("admin-token");
    if(token)token.value="";
    updateAuthState();
    flash(msg,"ok","已退出登录");
   }catch(e){flash(msg,"error",e.message||e)}
  };
 }
 function attachSave(){
  const button=document.getElementById("save");
  if(!button)return;
  button.onclick=async()=>{
   const msg=document.getElementById("save-msg");
   try{
    if(!verified)throw new Error("请先验证 ADMIN_TOKEN");
    const body=collect();
    await json("/api/admin/theme/settings",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    flash(msg,"ok","主题配置已保存");
   }catch(e){flash(msg,"error",e.message||e)}
  };
 }
boot();
</script>
</body>
</html>`
}
