import type { RuntimeConfig, WorkerEnv } from "./config";
import {
	getGeminiSessionAccounts,
	updateGeminiSessionAccount,
} from "./gemini/session-pool";
import type { GeminiSessionAccountAction } from "./gemini/session-pool";
import { timingSafeStringEqual } from "./shared/crypto";

const ADMIN_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>Gemini 账号池 · web2gem-plus</title>
  <style>
    :root{color-scheme:light;--bg:#f6f6f4;--panel:#fff;--text:#111;--muted:#686868;--line:#d9d9d5;--soft:#ededeb;--good:#166534;--good-bg:#dcfce7;--bad:#991b1b;--bad-bg:#fee2e2;--warn:#854d0e;--warn-bg:#fef3c7;--focus:#2563eb}
    @media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0b0b0b;--panel:#151515;--text:#f4f4f4;--muted:#a3a3a3;--line:#333;--soft:#222;--good:#86efac;--good-bg:#143621;--bad:#fca5a5;--bad-bg:#421818;--warn:#fde68a;--warn-bg:#422f12;--focus:#60a5fa}}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button{font:inherit}a{color:inherit}.skip{position:fixed;left:12px;top:-60px;background:var(--text);color:var(--bg);padding:10px 14px;z-index:10}.skip:focus{top:12px}.shell{width:min(1280px,100%);margin:auto;padding:28px 22px 56px}.topbar{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:24px}.eyebrow{margin:0 0 5px;color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase}h1{font-size:28px;line-height:1.2;margin:0 0 7px;letter-spacing:-.025em}.subtitle{margin:0;color:var(--muted);max-width:68ch}.button{border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:8px;padding:8px 12px;min-height:38px;cursor:pointer;transition:background-color .15s,border-color .15s}.button:hover{background:var(--soft)}.button:focus-visible{outline:3px solid color-mix(in srgb,var(--focus) 45%,transparent);outline-offset:2px}.button:disabled{opacity:.55;cursor:wait}.button.danger{color:var(--bad)}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.stat{border:1px solid var(--line);background:var(--panel);border-radius:10px;padding:15px 16px}.stat-label{color:var(--muted);font-size:12px}.stat-value{display:block;margin-top:4px;font-size:25px;line-height:1.15;font-weight:700;font-variant-numeric:tabular-nums}.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 16px;border-bottom:1px solid var(--line)}.panel-head h2{font-size:15px;margin:0}.updated{color:var(--muted);font-size:12px}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;min-width:1020px}th,td{text-align:left;padding:12px 14px;border-bottom:1px solid var(--line);vertical-align:middle}th{background:var(--soft);color:var(--muted);font-size:11px;letter-spacing:.05em;text-transform:uppercase}tbody tr:last-child td{border-bottom:0}.account{font-weight:650}.account-id{display:block;color:var(--muted);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;margin-top:2px}.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:650;white-space:nowrap}.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}.healthy{color:var(--good);background:var(--good-bg)}.auth_failed{color:var(--bad);background:var(--bad-bg)}.disabled{color:var(--warn);background:var(--warn-bg)}.number{font-variant-numeric:tabular-nums}.time{white-space:nowrap;color:var(--muted)}.actions{display:flex;gap:7px;white-space:nowrap}.actions .button{min-height:32px;padding:5px 9px;font-size:12px}.state{padding:44px 20px;text-align:center;color:var(--muted)}.state strong{display:block;color:var(--text);font-size:15px;margin-bottom:5px}.error{color:var(--bad)}.skeleton{height:14px;border-radius:5px;background:var(--soft);animation:pulse 1.2s ease-in-out infinite alternate}.notice{margin-top:12px;color:var(--muted);font-size:12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@keyframes pulse{to{opacity:.45}}@media(prefers-reduced-motion:reduce){.skeleton{animation:none}.button{transition:none}}@media(max-width:760px){.shell{padding:20px 14px 40px}.topbar{display:block}.topbar .button{margin-top:16px}.stats{grid-template-columns:repeat(2,minmax(0,1fr))}h1{font-size:24px}}@media(max-width:420px){.stats{grid-template-columns:1fr 1fr}.stat{padding:12px}.stat-value{font-size:21px}}
    .cooling{color:var(--bad);background:var(--bad-bg)}
  </style>
</head>
<body>
  <a class="skip" href="#main">跳到主要内容</a>
  <main id="main" class="shell">
    <header class="topbar">
      <div><p class="eyebrow">web2gem-plus / admin</p><h1>Gemini 账号池</h1><p class="subtitle">查看轮询账号的认证状态与活动记录。Cookie 和 SAPISID 不会在此页面或 API 中返回。</p></div>
      <button id="refresh" class="button" type="button">刷新状态</button>
    </header>
    <section class="stats" aria-label="账号池概览">
      <div class="stat"><span class="stat-label">账号总数</span><strong class="stat-value" id="total">—</strong></div>
      <div class="stat"><span class="stat-label">可用</span><strong class="stat-value" id="healthy">—</strong></div>
      <div class="stat"><span class="stat-label">认证失败</span><strong class="stat-value" id="failed">—</strong></div>
      <div class="stat"><span class="stat-label">累计成功</span><strong class="stat-value" id="successes">—</strong></div>
    </section>
    <section class="panel" aria-labelledby="accounts-title">
      <div class="panel-head"><h2 id="accounts-title">账号明细</h2><span id="updated" class="updated"></span></div>
      <div id="content" class="table-wrap" aria-busy="true">
        <table aria-label="加载账号状态"><tbody><tr><td><div class="skeleton"></div></td></tr><tr><td><div class="skeleton"></div></td></tr><tr><td><div class="skeleton"></div></td></tr></tbody></table>
      </div>
    </section>
    <p class="notice">“重新加入”会清除该账号的认证失败状态，使下一次请求重新验证它；不会修改 Worker secret。</p>
    <div id="announce" class="sr-only" aria-live="polite"></div>
  </main>
  <script>
    const content=document.querySelector('#content'),refresh=document.querySelector('#refresh'),announce=document.querySelector('#announce');
    const labels={healthy:'可用',cooling:'冷却中',disabled:'已停用'};
    const time=v=>v?new Intl.DateTimeFormat('zh-CN',{dateStyle:'short',timeStyle:'medium'}).format(new Date(v)):'—';
    const td=(text,cls='')=>{const el=document.createElement('td');el.textContent=text;if(cls)el.className=cls;return el};
    function summary(rows){document.querySelector('#total').textContent=rows.length;document.querySelector('#healthy').textContent=rows.filter(x=>x.status==='healthy').length;document.querySelector('#failed').textContent=rows.filter(x=>x.status==='cooling').length;document.querySelector('#successes').textContent=rows.reduce((n,x)=>n+x.success_count,0).toLocaleString();document.querySelector('#updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN')}
    function render(rows){summary(rows);content.replaceChildren();content.setAttribute('aria-busy','false');if(!rows.length){const empty=document.createElement('div');empty.className='state';empty.innerHTML='<strong>尚未配置账号</strong>请设置 GEMINI_COOKIE 或 GEMINI_COOKIES。';content.append(empty);return}const table=document.createElement('table');table.setAttribute('aria-label','Gemini 账号状态');table.innerHTML='<thead><tr><th>账号</th><th>状态</th><th>请求 / 成功</th><th>认证失败</th><th>最后成功</th><th>最后失败</th><th>Cookie 刷新</th><th>操作</th></tr></thead>';const body=document.createElement('tbody');for(const row of rows){const tr=document.createElement('tr');const account=td('');const name=document.createElement('span');name.className='account';name.textContent=row.position+'. '+row.label;const id=document.createElement('span');id.className='account-id';id.textContent=row.account_id;account.append(name,id);tr.append(account);const status=td('');const badge=document.createElement('span');badge.className='badge '+row.status;badge.textContent=labels[row.status]||row.status;status.append(badge);tr.append(status,td(row.request_count.toLocaleString()+' / '+row.success_count.toLocaleString(),'number'),td(row.auth_failure_count.toLocaleString(),'number'),td(time(row.last_success_at_ms),'time'),td(time(row.last_error_at_ms),'time'),td(row.refresh_count.toLocaleString(),'number'));const actions=td('','actions');if(row.status==='healthy'){actions.append(actionButton('停用','disable',row.account_id,true))}else{actions.append(actionButton('启用','enable',row.account_id,false))}actions.append(actionButton('重新加入','reset',row.account_id,false));tr.append(actions);body.append(tr)}table.append(body);content.append(table)}
    function actionButton(label,action,id,danger){const button=document.createElement('button');button.type='button';button.className='button'+(danger?' danger':'');button.textContent=label;button.addEventListener('click',()=>mutate(button,id,action));return button}
    async function load(){refresh.disabled=true;announce.textContent='正在刷新账号状态';try{const response=await fetch('/admin/api/accounts',{headers:{accept:'application/json'},cache:'no-store'});if(!response.ok)throw new Error('HTTP '+response.status);render((await response.json()).accounts);announce.textContent='账号状态已刷新'}catch(error){content.setAttribute('aria-busy','false');content.innerHTML='<div class="state error"><strong>无法加载账号状态</strong><span></span><br><button class="button" type="button">重试</button></div>';content.querySelector('span').textContent=String(error);content.querySelector('button').addEventListener('click',load);announce.textContent='加载账号状态失败'}finally{refresh.disabled=false}}
    async function mutate(button,account_id,action){button.disabled=true;announce.textContent='正在更新账号';try{const response=await fetch('/admin/api/accounts',{method:'PATCH',headers:{'content-type':'application/json','accept':'application/json'},body:JSON.stringify({account_id,action})});if(!response.ok)throw new Error('HTTP '+response.status);render((await response.json()).accounts);announce.textContent='账号状态已更新'}catch(error){announce.textContent='更新失败：'+String(error);button.disabled=false}}
    refresh.addEventListener('click',load);load();
  </script>
</body>
</html>`;

export async function handleAdminRequest(
	request: Request,
	env: WorkerEnv,
	cfg: RuntimeConfig,
): Promise<Response> {
	const url = new URL(request.url);
	if (!cfg.admin_password) return new Response("Not Found", { status: 404 });
	if (!adminAuthorized(request, cfg.admin_password)) return adminChallenge();

	if (url.pathname === "/admin" || url.pathname === "/admin/") {
		if (request.method !== "GET" && request.method !== "HEAD")
			return new Response("Method Not Allowed", { status: 405 });
		return new Response(request.method === "HEAD" ? null : ADMIN_HTML, {
			headers: adminPageHeaders(),
		});
	}
	if (url.pathname !== "/admin/api/accounts")
		return adminJson({ error: "not_found" }, 404);

	if (request.method === "GET") {
		return adminJson({ accounts: await getGeminiSessionAccounts(cfg, env) });
	}
	if (request.method === "PATCH") {
		const origin = request.headers.get("origin");
		if (origin && origin !== url.origin)
			return adminJson({ error: "origin_mismatch" }, 403);
		let body: unknown;
		try {
			body = await request.json();
		} catch (_) {
			return adminJson({ error: "invalid_json" }, 400);
		}
		if (!isAccountActionBody(body))
			return adminJson({ error: "invalid_account_action" }, 400);
		try {
			return adminJson({
				accounts: await updateGeminiSessionAccount(
					cfg,
					env,
					body.account_id,
					body.action,
				),
			});
		} catch (error) {
			if (error instanceof Error && error.message === "account_not_found")
				return adminJson({ error: "account_not_found" }, 404);
			throw error;
		}
	}
	return adminJson({ error: "method_not_allowed" }, 405);
}

function adminAuthorized(request: Request, password: string): boolean {
	const match = /^Basic\s+([^\s]+)$/i.exec(
		request.headers.get("authorization") || "",
	);
	if (!match?.[1]) return false;
	try {
		const bytes = Uint8Array.from(atob(match[1]), (char) => char.charCodeAt(0));
		const decoded = new TextDecoder().decode(bytes);
		const separator = decoded.indexOf(":");
		if (separator < 0 || decoded.slice(0, separator) !== "admin") return false;
		return timingSafeStringEqual(decoded.slice(separator + 1), password);
	} catch (_) {
		return false;
	}
}

function adminChallenge(): Response {
	return new Response("Admin authentication required", {
		status: 401,
		headers: {
			"WWW-Authenticate": 'Basic realm="web2gem-plus admin", charset="UTF-8"',
			"Cache-Control": "no-store",
		},
	});
}

function adminPageHeaders(): HeadersInit {
	return {
		"Content-Type": "text/html; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Security-Policy":
			"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
		"Referrer-Policy": "no-referrer",
		"X-Content-Type-Options": "nosniff",
	};
}

function adminJson(body: unknown, status = 200): Response {
	return Response.json(body, {
		status,
		headers: {
			"Cache-Control": "no-store",
			"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

function isAccountActionBody(
	value: unknown,
): value is { account_id: string; action: GeminiSessionAccountAction } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const body = value as Record<string, unknown>;
	return (
		typeof body.account_id === "string" &&
		/^[a-f0-9]{24}$/.test(body.account_id) &&
		(body.action === "enable" ||
			body.action === "disable" ||
			body.action === "reset")
	);
}
